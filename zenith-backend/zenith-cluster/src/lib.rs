use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use tokio::runtime::Runtime;
use zeromq::{Socket, SocketRecv, SocketSend, RepSocket, ReqSocket};
use once_cell::sync::Lazy;
use std::sync::Mutex;

static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
});

static SERVER_STATE: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

/// # Safety
/// `endpoint` must be null or a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn start_zmq_server(endpoint: *const c_char, callback: extern "C" fn(*const c_char) -> *mut c_char) -> i32 {
    if endpoint.is_null() {
        return -1;
    }

    let c_str = unsafe { CStr::from_ptr(endpoint) };
    let endpoint_str = match c_str.to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return -2,
    };

    let mut state = SERVER_STATE.lock().unwrap();
    if *state {
        return 1; // Already running
    }
    *state = true;

    RUNTIME.spawn(async move {
        println!("[Zenith ZMQ] Starting RepSocket on {}", endpoint_str);
        let mut socket = RepSocket::new();
        
        match socket.bind(&endpoint_str).await {
            Ok(_) => println!("[Zenith ZMQ] Successfully bound to {}", endpoint_str),
            Err(e) => {
                println!("[Zenith ZMQ] Failed to bind: {:?}", e);
                return;
            }
        }

        loop {
            match socket.recv().await {
                Ok(msg) => {
                    let msg_str = String::from_utf8_lossy(msg.get(0).unwrap());
                    println!("[Zenith ZMQ] Received message: {}", msg_str);
                    
                    // Call the Deno Callback
                    let c_msg = CString::new(msg_str.to_string()).unwrap();
                    let response_ptr = callback(c_msg.as_ptr());
                    
                    if !response_ptr.is_null() {
                       let response_str = unsafe { CStr::from_ptr(response_ptr) }.to_string_lossy();
                       let _ = socket.send(response_str.to_string().into()).await;
                       // We don't free response_ptr here, Deno should manage its own memory or we expose a free for it
                    } else {
                       let response = format!("{{\"status\":\"ok\", \"received\":\"{}\"}}", msg_str);
                       let _ = socket.send(response.into()).await;
                    }
                }
                Err(e) => {
                    println!("[Zenith ZMQ] Receive error: {:?}", e);
                }
            }
        }
    });

    0
}

/// # Safety
/// `endpoint` and `message` must be null or valid NUL-terminated strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn send_zmq_message(endpoint: *const c_char, message: *const c_char) -> *mut c_char {
    if endpoint.is_null() || message.is_null() {
        return CString::new("{\"error\":\"null arguments\"}").unwrap().into_raw();
    }

    let endpoint_str = unsafe { CStr::from_ptr(endpoint) }.to_string_lossy().to_string();
    let message_str = unsafe { CStr::from_ptr(message) }.to_string_lossy().to_string();

    let res = RUNTIME.block_on(async move {
        let mut socket = ReqSocket::new();
        if socket.connect(&endpoint_str).await.is_err() {
            return "{\"error\":\"connect failed\"}".to_string();
        }
        
        if socket.send(message_str.into()).await.is_err() {
            return "{\"error\":\"send failed\"}".to_string();
        }
        
        match socket.recv().await {
            Ok(rep) => String::from_utf8_lossy(rep.get(0).unwrap()).to_string(),
            Err(_) => "{\"error\":\"recv failed\"}".to_string()
        }
    });

    CString::new(res).unwrap().into_raw()
}

/// # Safety
/// `s` must be null or a pointer returned by this library that was not freed yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_string(s: *mut c_char) {
    if s.is_null() { return; }
    unsafe {
        let _ = CString::from_raw(s);
    }
}
