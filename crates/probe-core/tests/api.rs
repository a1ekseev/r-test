//! The client against a real in-process server over loopback: HTTP, signed login, WebSocket.

use probe_core::{Client, Error};
use serde_json::{Value, json};

const EMAIL: &str = "user@example.com";

async fn start() -> (probe_server::Running, Client) {
    let server = probe_server::start("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let client = Client::new(&server.base_url(), b"").unwrap();
    (server, client)
}

/// Reads the code the server "sent" to the mailbox.
async fn sent_code(base: &str) -> String {
    let json: Value = reqwest::get(format!("{base}/debug/code?email={EMAIL}")).await.unwrap().json().await.unwrap();
    json["code"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn ping_and_echo() {
    let (server, client) = start().await;
    client.ping().await.unwrap();
    let value = json!({ "text": "hello", "n": [1, 2, 3] });
    assert_eq!(client.echo(&value).await.unwrap(), value);
    server.stop().await.unwrap();
}

#[tokio::test]
async fn login_with_code() {
    let (server, client) = start().await;
    client.request_code(EMAIL).await.unwrap();
    let code = sent_code(&server.base_url()).await;
    assert_eq!(code.len(), 6);

    let wrong = if code == "000000" { "111111" } else { "000000" };
    assert!(matches!(client.confirm_code(EMAIL, wrong).await, Err(Error::Rejected(c)) if c == "bad_code"));

    let token = client.confirm_code(EMAIL, &code).await.unwrap();
    assert_eq!(token.len(), 36, "{token}");
    // a code is single-use
    assert!(matches!(client.confirm_code(EMAIL, &code).await, Err(Error::Rejected(c)) if c == "bad_code"));
    server.stop().await.unwrap();
}

#[tokio::test]
async fn malformed_email_is_rejected() {
    let (server, client) = start().await;
    assert!(matches!(client.request_code("not-an-email").await, Err(Error::Rejected(c)) if c == "bad_email"));
    server.stop().await.unwrap();
}

#[tokio::test]
async fn unsigned_login_is_rejected() {
    let (server, _client) = start().await;
    let res = reqwest::Client::new()
        .post(format!("{}/login", server.base_url()))
        .json(&json!({ "email": EMAIL }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "bad_signature" }));
    server.stop().await.unwrap();
}

#[tokio::test]
async fn websocket_ping_pong() {
    let (server, client) = start().await;
    assert_eq!(client.ws_ping(42).await.unwrap(), 42);
    server.stop().await.unwrap();
}

#[tokio::test]
async fn unreachable_server_is_a_network_error() {
    let (server, client) = start().await;
    server.stop().await.unwrap();
    assert!(matches!(client.ping().await, Err(Error::Network(_))));
    assert!(matches!(client.ws_ping(1).await, Err(Error::Network(_))));
}

#[test]
fn device_facts_are_available() {
    let device = probe_core::device();
    println!("{device:?}");
    assert!(!device.hostname.is_empty());
    assert!(!device.os.is_empty());
}
