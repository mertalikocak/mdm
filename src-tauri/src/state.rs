use crate::db::Database;
use crate::engine::DownloadManager;
use crate::video::VideoManager;
use std::sync::Arc;

pub struct AppState {
    pub db: Arc<Database>,
    pub engine: Arc<DownloadManager>,
    pub video_engine: Arc<VideoManager>,
}
