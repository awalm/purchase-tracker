use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

pub struct AuditService;

impl AuditService {
    /// Records an audit log entry
    pub async fn log<T: Serialize, U: Serialize>(
        pool: &PgPool,
        table_name: &str,
        record_id: Uuid,
        operation: &str,
        old_data: Option<&T>,
        new_data: Option<&U>,
        user_id: Uuid,
    ) -> sqlx::Result<()> {
        let old_data_json = old_data.and_then(|d| serde_json::to_value(d).ok());
        let new_data_json = new_data.and_then(|d| serde_json::to_value(d).ok());

        sqlx::query!(
            r#"INSERT INTO audit_log (table_name, record_id, operation, old_data, new_data, user_id)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
            table_name,
            record_id,
            operation,
            old_data_json,
            new_data_json,
            user_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }
}
