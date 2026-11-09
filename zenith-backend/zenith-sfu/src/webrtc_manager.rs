use std::collections::HashMap;
use tracing::info;

pub struct WebRtcManager {
    streams: HashMap<String, StreamContext>,
}

#[allow(dead_code)] // filled in once the peer connection is wired
pub struct StreamContext {
    pub stream_id: String,
    // Aquí guardaríamos el webrtc::peer_connection::RTCPeerConnection
    // pub peer_connection: Arc<RTCPeerConnection>,
}

impl WebRtcManager {
    pub fn new() -> Self {
        Self {
            streams: HashMap::new(),
        }
    }

    pub async fn allocate(&mut self, stream_id: &str) {
        // En la implementación real, inicializamos la API de webrtc-rs
        // let api = webrtc::api::APIBuilder::new().build();
        // let config = RTCConfiguration::default();
        // let peer_connection = api.new_peer_connection(config).await.unwrap();

        info!("Stream context {} initialized in WebRtcManager", stream_id);
        
        self.streams.insert(
            stream_id.to_string(),
            StreamContext {
                stream_id: stream_id.to_string(),
            },
        );
    }
}
