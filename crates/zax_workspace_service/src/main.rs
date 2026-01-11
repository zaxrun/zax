use tonic::{Request, Response, Status};

pub mod zax {
    pub mod v1 {
        // Allow clippy warnings on generated proto code
        #![allow(clippy::all)]
        #![allow(clippy::pedantic)]
        tonic::include_proto!("zax.v1");
    }
}

use zax::v1::workspace_service_server::WorkspaceService;
use zax::v1::{
    GetDeltaSummaryRequest, GetDeltaSummaryResponse, IngestManifestRequest, IngestManifestResponse,
    PingRequest, PingResponse,
};

pub struct WorkspaceServiceImpl;

#[tonic::async_trait]
impl WorkspaceService for WorkspaceServiceImpl {
    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        Err(Status::unimplemented("Not implemented"))
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

fn main() {
    // Stub: exits 0 immediately for bootstrap verification
    // No server started - compile verification only
}
