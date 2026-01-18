#![allow(clippy::print_stderr)]
#![allow(clippy::unwrap_used)]

use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::fs;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};
use tonic::transport::Server;
use tonic::{Request, Response, Status};

mod affected;
mod normalize;
mod parsers;
mod rpc;
mod store;

pub mod zax {
    pub mod v1 {
        #![allow(clippy::all)]
        #![allow(clippy::pedantic)]
        tonic::include_proto!("zax.v1");
    }
}

use affected::AffectedState;
use zax::v1::workspace_service_server::{WorkspaceService, WorkspaceServiceServer};
use zax::v1::{
    GetAffectedTestsRequest, GetAffectedTestsResponse, GetDeltaSummaryRequest,
    GetDeltaSummaryResponse, IngestManifestRequest, IngestManifestResponse, PingRequest,
    PingResponse,
};

pub struct WorkspaceServiceImpl {
    state: rpc::RpcState,
    affected: Arc<Mutex<AffectedState>>,
}

#[tonic::async_trait]
impl WorkspaceService for WorkspaceServiceImpl {
    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        let response = PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        Ok(Response::new(response))
    }

    async fn ingest_manifest(
        &self,
        request: Request<IngestManifestRequest>,
    ) -> Result<Response<IngestManifestResponse>, Status> {
        let manifest = request
            .into_inner()
            .manifest
            .ok_or_else(|| Status::invalid_argument("manifest is required"))?;
        rpc::ingest_manifest(&self.state, &manifest)?;
        Ok(Response::new(IngestManifestResponse {}))
    }

    async fn get_delta_summary(
        &self,
        request: Request<GetDeltaSummaryRequest>,
    ) -> Result<Response<GetDeltaSummaryResponse>, Status> {
        let req = request.into_inner();
        let result = rpc::get_delta_summary(&self.state, &req.workspace_id)?;
        Ok(Response::new(GetDeltaSummaryResponse {
            new_findings: result.new_findings,
            fixed_findings: result.fixed_findings,
            new_test_failures: result.new_test_failures,
            fixed_test_failures: result.fixed_test_failures,
        }))
    }

    async fn get_affected_tests(
        &self,
        request: Request<GetAffectedTestsRequest>,
    ) -> Result<Response<GetAffectedTestsResponse>, Status> {
        let req = request.into_inner();
        let result = {
            let mut affected = self
                .affected
                .lock()
                .map_err(|_| Status::internal("affected lock error"))?;
            affected.get_affected_tests(req.force_full)
        };
        Ok(Response::new(GetAffectedTestsResponse {
            test_files: result.test_files,
            dirty_files: result.dirty_files,
            is_full_run: result.is_full_run,
        }))
    }
}

async fn write_port_file(cache_dir: &Path, port: u16) -> std::io::Result<()> {
    let port_file = cache_dir.join("rust.port");
    let tmp_file = cache_dir.join("rust.port.tmp");
    fs::write(&tmp_file, port.to_string()).await?;
    fs::rename(&tmp_file, &port_file).await?;
    Ok(())
}

#[allow(clippy::too_many_lines)]
async fn run_server(
    cache_dir: PathBuf,
    workspace_root: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "127.0.0.1:0".parse()?;
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let port = local_addr.port();

    // Initialize storage before anything else
    store::init_storage(&cache_dir)?;
    let conn = store::open_connection(&cache_dir)?;

    // Initialize affected state
    let mut affected_state = AffectedState::new(workspace_root.clone());
    if let Err(e) = affected_state.start_watcher() {
        eprintln!("[affected] ERROR: {e}");
    }
    let affected = Arc::new(Mutex::new(affected_state));

    // Start graph initialization in background
    let (ws_root, graph_arc, ready_arc) = {
        let state = affected.lock().unwrap();
        (
            state.workspace_root.clone(),
            Arc::clone(&state.graph),
            Arc::clone(&state.graph_ready),
        )
    };
    tokio::spawn(async move {
        build_graph_async(ws_root, graph_arc, ready_arc).await;
    });

    write_port_file(&cache_dir, port).await?;

    let service = WorkspaceServiceImpl {
        state: rpc::RpcState {
            cache_dir: cache_dir.clone(),
            conn: Arc::new(Mutex::new(conn)),
        },
        affected,
    };
    let incoming = tokio_stream::wrappers::TcpListenerStream::new(listener);
    let mut sigterm = signal(SignalKind::terminate())?;

    Server::builder()
        .add_service(WorkspaceServiceServer::new(service))
        .serve_with_incoming_shutdown(incoming, async {
            sigterm.recv().await;
        })
        .await?;

    Ok(())
}

/// Build the dependency graph asynchronously.
#[allow(clippy::too_many_lines)]
async fn build_graph_async(
    workspace_root: PathBuf,
    graph: affected::SharedDepGraph,
    graph_ready: Arc<std::sync::atomic::AtomicBool>,
) {
    use affected::{parse_imports, PathResolver};
    use ignore::WalkBuilder;
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    const GRAPH_INIT_TIMEOUT_SECS: u64 = 30;

    let start = Instant::now();
    eprintln!(
        "[affected] INFO: starting graph build for {}",
        workspace_root.display()
    );

    let resolver = PathResolver::new(workspace_root.clone());
    let mut file_count = 0;

    let walker = WalkBuilder::new(&workspace_root)
        .hidden(false)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        if !is_ts_js_file(entry.path()) {
            continue;
        }

        let Ok(path) = entry.path().canonicalize() else {
            continue;
        };

        // Add file to graph
        {
            let mut g = graph.write().unwrap();
            if g.add_file(path.clone()).is_none() {
                eprintln!("[affected] WARN: graph overflow during init");
                break;
            }
        }

        // Parse imports and resolve
        let imports = parse_imports(&path);
        let mut resolved = Vec::new();
        for import in imports {
            if let Some(resolved_path) = resolver.resolve(&path, &import.specifier) {
                let mut g = graph.write().unwrap();
                if g.add_file(resolved_path.clone()).is_some() {
                    resolved.push(resolved_path);
                }
            }
        }

        // Update edges
        {
            let mut g = graph.write().unwrap();
            g.update_edges(&path, &resolved);
        }

        file_count += 1;

        if start.elapsed().as_secs() > GRAPH_INIT_TIMEOUT_SECS {
            eprintln!(
                "[affected] WARN: graph init timeout after {}s",
                GRAPH_INIT_TIMEOUT_SECS
            );
            break;
        }
    }

    let (node_count, edge_count) = {
        let g = graph.read().unwrap();
        (g.node_count(), g.edge_count())
    };

    eprintln!(
        "[affected] INFO: graph build complete: {} files, {} nodes, {} edges in {}ms",
        file_count,
        node_count,
        edge_count,
        start.elapsed().as_millis()
    );

    graph_ready.store(true, Ordering::SeqCst);
}

fn is_ts_js_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    matches!(
        ext,
        "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs" | "cts" | "cjs"
    )
}

#[allow(clippy::print_stderr)]
#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: zax_workspace_service <cache_dir> <workspace_root>");
        std::process::exit(1);
    }

    let cache_dir = PathBuf::from(&args[1]);
    let workspace_root = PathBuf::from(&args[2]);

    if let Err(e) = run_server(cache_dir, workspace_root).await {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tonic::Request;

    fn create_test_service() -> (WorkspaceServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        store::init_storage(dir.path()).unwrap();
        let conn = store::open_connection(dir.path()).unwrap();
        let affected = AffectedState::new(dir.path().to_path_buf());
        let service = WorkspaceServiceImpl {
            state: rpc::RpcState {
                cache_dir: dir.path().to_path_buf(),
                conn: Arc::new(Mutex::new(conn)),
            },
            affected: Arc::new(Mutex::new(affected)),
        };
        (service, dir)
    }

    #[tokio::test]
    async fn ping_returns_cargo_pkg_version() {
        let (service, _dir) = create_test_service();
        let request = Request::new(PingRequest {});
        let response = service.ping(request).await.unwrap();
        assert_eq!(response.get_ref().version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn ping_version_is_semver() {
        let (service, _dir) = create_test_service();
        let request = Request::new(PingRequest {});
        let response = service.ping(request).await.unwrap();
        let version = &response.get_ref().version;
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(parts.len(), 3, "Version should be semver: {version}");
        for part in &parts {
            assert!(part.parse::<u32>().is_ok(), "Invalid semver part: {part}");
        }
    }

    #[tokio::test]
    async fn write_port_file_creates_file() {
        let dir = tempdir().unwrap();
        write_port_file(dir.path(), 12345).await.unwrap();
        let content = tokio::fs::read_to_string(dir.path().join("rust.port"))
            .await
            .unwrap();
        assert_eq!(content, "12345");
    }

    #[tokio::test]
    async fn write_port_file_is_atomic() {
        let dir = tempdir().unwrap();
        write_port_file(dir.path(), 54321).await.unwrap();
        // tmp file should not exist after atomic write
        assert!(!dir.path().join("rust.port.tmp").exists());
        // final file should exist
        assert!(dir.path().join("rust.port").exists());
    }

    #[tokio::test]
    async fn write_port_file_overwrites_existing() {
        let dir = tempdir().unwrap();
        write_port_file(dir.path(), 11111).await.unwrap();
        write_port_file(dir.path(), 22222).await.unwrap();
        let content = tokio::fs::read_to_string(dir.path().join("rust.port"))
            .await
            .unwrap();
        assert_eq!(content, "22222");
    }
}
