use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};
use tonic::transport::Server;
use tonic::{Request, Response, Status};

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

pub struct WorkspaceServiceImpl;

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
        _request: Request<IngestManifestRequest>,
    ) -> Result<Response<IngestManifestResponse>, Status> {
        Err(Status::unimplemented("Not implemented"))
    }

    async fn get_delta_summary(
        &self,
        _request: Request<GetDeltaSummaryRequest>,
    ) -> Result<Response<GetDeltaSummaryResponse>, Status> {
        Err(Status::unimplemented("Not implemented"))
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

    write_port_file(&cache_dir, port).await?;

    let service = WorkspaceServiceImpl;
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
