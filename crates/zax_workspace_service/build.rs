fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")?;
    let proto_path = format!("{}/../../proto", manifest_dir);

    tonic_build::configure()
        .build_server(true)
        .compile_protos(
            &[format!("{}/zax/v1/workspace.proto", proto_path)],
            &[&proto_path],
        )?;

    Ok(())
}
