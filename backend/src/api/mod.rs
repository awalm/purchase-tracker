pub mod auth;
pub mod destinations;
pub mod import;
pub mod invoices;
pub mod items;
pub mod purchases;
pub mod receipts;
pub mod reports;
pub mod travel;
pub mod vendors;

use axum::{http::StatusCode, routing::get, Router};
use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub jwt_secret: String,
}

impl AppState {
    pub fn new(pool: PgPool, jwt_secret: String) -> Self {
        Self { pool, jwt_secret }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health_check))
        .nest("/auth", auth::router())
        .nest("/vendors", vendors::router())
        .nest("/destinations", destinations::router())
        .nest("/items", items::router())
        .nest("/invoices", invoices::router())
        .nest("/receipts", receipts::router())
        .nest("/purchases", purchases::router())
        .nest("/reports", reports::router())
        .nest("/import", import::router())
        .nest("/travel", travel::router())
}

async fn health_check() -> StatusCode {
    StatusCode::OK
}
