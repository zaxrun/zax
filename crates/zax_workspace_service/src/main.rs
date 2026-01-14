use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::fs;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};
use tonic::transport::Server;
use tonic::{Request, Response, Status};

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

use zax::v1::workspace_service_server::{WorkspaceService, WorkspaceServiceServer};
use zax::v1::{
    GetDeltaSummaryRequest, GetDeltaSummaryResponse, IngestManifestRequest,
    IngestManifestResponse, PingRequest, PingResponse,
};

pub struct WorkspaceServiceImpl {
    state: rpc::RpcState,
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
        let manifest = request.into_inner().manifest.ok_or_else(|| {
            Status::invalid_argument("manifest is required")
        })?;
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
}

async fn write_port_file(cache_dir: &Path, port: u16) -> std::io::Result<()> {
    let port_file = cache_dir.join("rust.port");
    let tmp_file = cache_dir.join("rust.port.tmp");
    fs::write(&tmp_file, port.to_string()).await?;
    fs::rename(&tmp_file, &port_file).await?;
    Ok(())
}

async fn run_server(cache_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "127.0.0.1:0".parse()?;
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let port = local_addr.port();

    // Initialize storage before anything else
    store::init_storage(&cache_dir)?;
    let conn = store::open_connection(&cache_dir)?;

    write_port_file(&cache_dir, port).await?;

    let service = WorkspaceServiceImpl {
        state: rpc::RpcState {
            cache_dir: cache_dir.clone(),
            conn: Arc::new(Mutex::new(conn)),
        },
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

#[allow(clippy::print_stderr)]
#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Error: cache directory argument required");
        std::process::exit(1);
    }

    let cache_dir = PathBuf::from(&args[1]);
    if let Err(e) = run_server(cache_dir).await {
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

    fn create_test_service() -> WorkspaceServiceImpl {
        let dir = tempdir().unwrap();
        store::init_storage(dir.path()).unwrap();
        let conn = store::open_connection(dir.path()).unwrap();
        WorkspaceServiceImpl {
            state: rpc::RpcState {
                cache_dir: dir.path().to_path_buf(),
                conn: Arc::new(Mutex::new(conn)),
            },
        }
    }

    #[tokio::test]
    async fn ping_returns_cargo_pkg_version() {
        let service = create_test_service();
        let request = Request::new(PingRequest {});
        let response = service.ping(request).await.unwrap();
        assert_eq!(response.get_ref().version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn ping_version_is_semver() {
        let service = create_test_service();
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
