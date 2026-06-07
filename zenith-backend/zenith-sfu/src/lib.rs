use std::ffi::CStr;
use std::os::raw::c_char;
use std::panic::catch_unwind;
use std::sync::Once;
use tracing::{info, error, Level};
use tracing_subscriber::FmtSubscriber;

mod webrtc_manager;

static INIT: Once = Once::new();

fn init_logger() {
    INIT.call_once(|| {
        let subscriber = FmtSubscriber::builder()
            .with_max_level(Level::INFO)
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
        info!("Zenith SFU FFI Library initialized");
    });
}

/// Asigna recursos para un stream WebRTC de manera sincrónica (C-ABI)
/// Retorna 1 si es exitoso, 0 si hay error, -1 si hay panic.
#[no_mangle]
pub extern "C" fn allocate_stream_ffi(
    stream_id_ptr: *const c_char,
    publisher_id_ptr: *const c_char,
) -> i32 {
    let result = catch_unwind(|| {
        init_logger();

        if stream_id_ptr.is_null() || publisher_id_ptr.is_null() {
            error!("FFI Panic Prevention: Null pointers received");
            return 0; // Failure
        }

        let stream_id = unsafe { CStr::from_ptr(stream_id_ptr) }.to_string_lossy();
        let publisher_id = unsafe { CStr::from_ptr(publisher_id_ptr) }.to_string_lossy();

        info!(
            "FFI: Allocating stream {} for publisher {}",
            stream_id, publisher_id
        );

        // Aquí se crearía una instancia temporal del runtime asíncrono para inicializar recursos.
        // En producción se usa un lazy_static con un Runtime tokio corriendo de fondo.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut manager = webrtc_manager::WebRtcManager::new();
            manager.allocate(&stream_id).await;
        });

        1 // Success
    });

    match result {
        Ok(code) => code,
        Err(_) => {
            // Panic captured! Safe for Deno.
            eprintln!("CRITICAL ERROR: Rust SFU Panicked during allocate_stream_ffi");
            -1 // Panic code
        }
    }
}
