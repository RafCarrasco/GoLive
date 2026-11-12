//! Login pelo navegador do sistema: o app abre `/desktop-login` com uma porta local e um código
//! de uso único; a página faz o login do Google e envia a credencial para
//! `http://127.0.0.1:<porta>/callback`. Mesmas regras do `signInWithBrowser` de `desktop/main.cjs`.
//!
//! Só usa `std` (sem Tauri) para os testes dirigirem o servidor com um `TcpStream` comum.

use std::fmt;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// Corpo maior que isto derruba a conexão sem resposta.
pub const BODY_LIMIT: usize = 64 * 1024;
/// Cabeçalhos de um formulário cabem com folga; acima disso não é o navegador.
const HEAD_LIMIT: usize = 16 * 1024;
/// O login só espera uma aba; o limite evita que outro programa local abra conexões sem fim.
const MAX_CONNECTIONS: usize = 16;
/// Uma aba faz um pedido só; o limite existe para uma conexão não ficar aberta para sempre.
const MAX_REQUESTS_PER_CONNECTION: usize = 32;

pub const CANCELLED: &str = "Login cancelado.";
pub const EXPIRED: &str = "O login expirou. Tente de novo.";
pub const MISSING_CREDENTIAL: &str = "O Google não devolveu a credencial. Tente de novo.";

const DONE_PAGE: &str = r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nimbo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#eef1ff;
font-family:Inter,Segoe UI,system-ui,sans-serif}div{text-align:center}h1{font-size:22px;margin:0 0 8px}
p{color:#9aa6c4;margin:0}</style></head><body><div><h1>Pronto, você entrou.</h1>
<p>Pode fechar esta aba e voltar ao app Nimbo.</p></div></body></html>"#;

/// Credencial do Google devolvida pela página de login.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub id_token: String,
    pub access_token: String,
}

// Sem `derive(Debug)`: um `{:?}` esquecido não pode levar token para log ou mensagem de teste.
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials(..)")
    }
}

/// Como um login terminou.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    SignedIn(Credentials),
    /// A página voltou com o código certo, mas sem `idToken`.
    MissingCredential,
    Cancelled,
    Expired,
}

/// Tempos do servidor. Os testes encurtam para não esperar os 5 minutos de verdade.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Quanto tempo o login fica esperando o navegador.
    pub expiry: Duration,
    /// De quanto em quanto tempo o servidor confere se foi cancelado ou expirou.
    pub poll: Duration,
    /// Tempo máximo para uma conexão mandar o pedido inteiro.
    pub io: Duration,
    /// Tempo que a conexão já respondida fica aberta esperando o navegador fechar.
    pub linger: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            expiry: Duration::from_secs(5 * 60),
            poll: Duration::from_millis(20),
            io: Duration::from_secs(10),
            linger: Duration::from_secs(5),
        }
    }
}

struct Shared {
    state: String,
    timing: Timing,
    /// Quem tira o remetente daqui decide o resultado; vazio significa login encerrado.
    outcome: Mutex<Option<Sender<Outcome>>>,
    connections: AtomicUsize,
}

impl Shared {
    fn pending(&self) -> bool {
        self.outcome
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Encerra o login com `outcome`. Só o primeiro a chamar vale.
    fn finish(&self, outcome: Outcome) -> bool {
        let sender = self
            .outcome
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match sender {
            Some(sender) => {
                // Se ninguém mais espera o resultado, não há o que avisar.
                let _ = sender.send(outcome);
                true
            }
            None => false,
        }
    }
}

/// Um login em andamento: a porta e o código que vão no link, e o resultado quando chegar.
pub struct Login {
    pub port: u16,
    pub state: String,
    shared: Arc<Shared>,
    outcome: Receiver<Outcome>,
    /// Só os testes esperam a thread acabar, para saber que a porta fechou de fato.
    #[cfg(test)]
    acceptor: Option<thread::JoinHandle<()>>,
}

impl Login {
    /// Abre a porta local e começa a esperar o navegador.
    pub fn start(timing: Timing) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        // Sem bloquear no accept: a mesma thread precisa notar cancelamento e expiração.
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let state = new_state()?;
        let (sender, outcome) = mpsc::channel();
        let shared = Arc::new(Shared {
            state: state.clone(),
            timing,
            outcome: Mutex::new(Some(sender)),
            connections: AtomicUsize::new(0),
        });
        let acceptor = thread::Builder::new().name("nimbo-login".into()).spawn({
            let shared = Arc::clone(&shared);
            move || accept_until_done(listener, shared)
        })?;
        // Fora dos testes a thread fica solta: ela termina sozinha quando o login acaba.
        #[cfg(not(test))]
        drop(acceptor);
        Ok(Self {
            port,
            state,
            shared,
            outcome,
            #[cfg(test)]
            acceptor: Some(acceptor),
        })
    }

    /// Espera o resultado (bloqueia a thread).
    pub fn wait(&self) -> Outcome {
        self.outcome.recv().unwrap_or(Outcome::Cancelled)
    }

    pub fn cancel(&self) {
        self.shared.finish(Outcome::Cancelled);
    }

    /// Espera a porta local ser fechada de fato.
    #[cfg(test)]
    fn closed(&mut self) {
        if let Some(acceptor) = self.acceptor.take() {
            acceptor.join().expect("a thread do login não deve falhar");
        }
    }
}

impl Drop for Login {
    fn drop(&mut self) {
        // Quem pediu o login desistiu de esperar: não deixa a porta aberta até expirar.
        self.cancel();
    }
}

/// Garante um login por vez: começar outro cancela o anterior.
#[derive(Default)]
pub struct LoginManager {
    current: Mutex<Option<Arc<Shared>>>,
}

impl LoginManager {
    pub fn begin(&self, timing: Timing) -> io::Result<Login> {
        // Tudo com a trava na mão: dois pedidos ao mesmo tempo não deixam dois logins abertos.
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(previous) = current.take() {
            previous.finish(Outcome::Cancelled);
        }
        let login = Login::start(timing)?;
        *current = Some(Arc::clone(&login.shared));
        Ok(login)
    }

    pub fn cancel(&self) {
        let current = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(shared) = current {
            shared.finish(Outcome::Cancelled);
        }
    }
}

/// Link que o navegador abre: `<site>/desktop-login?port=<porta>&state=<código>`.
pub fn login_url(app_url: &str, port: u16, state: &str) -> String {
    let base = app_url.strip_suffix('/').unwrap_or(app_url);
    format!("{base}/desktop-login?port={port}&state={state}")
}

/// Código de uso único: 24 bytes aleatórios do sistema em hexadecimal (48 caracteres).
fn new_state() -> io::Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn accept_until_done(listener: TcpListener, shared: Arc<Shared>) {
    let deadline = Instant::now() + shared.timing.expiry;
    while shared.pending() {
        if Instant::now() >= deadline {
            shared.finish(Outcome::Expired);
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => serve(stream, &shared),
            // Nada chegando, ou uma conexão que morreu antes do accept: tenta de novo logo mais.
            Err(_) => thread::sleep(shared.timing.poll),
        }
    }
    // Soltar o listener aqui para de aceitar conexões novas. As que já estão sendo respondidas
    // têm a própria thread e continuam até o navegador fechar (ver `handle`).
}

fn serve(stream: TcpStream, shared: &Arc<Shared>) {
    if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
        shared.connections.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    let worker = thread::Builder::new()
        .name("nimbo-login-conn".into())
        .spawn({
            let shared = Arc::clone(shared);
            move || {
                handle(stream, &shared);
                shared.connections.fetch_sub(1, Ordering::SeqCst);
            }
        });
    if worker.is_err() {
        shared.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Atende uma conexão do jeito que o servidor http do Node atendia: ela continua aberta depois da
/// resposta e quem fecha é o navegador. Fechar primeiro deste lado, no Windows, às vezes fazia a
/// aba mostrar "conexão redefinida" no lugar da página "Pronto" (ver o comentário em
/// desktop/main.cjs). Conexão parada por mais de `linger` é encerrada.
fn handle(mut stream: TcpStream, shared: &Shared) {
    let timing = shared.timing;
    // No Windows a conexão aceita herda o modo sem bloqueio do listener.
    if stream.set_nonblocking(false).is_err() || stream.set_write_timeout(Some(timing.io)).is_err()
    {
        return;
    }
    let mut wait = timing.io;
    let mut pending = Vec::new();
    for _ in 0..MAX_REQUESTS_PER_CONNECTION {
        match answer(&mut stream, shared, pending, wait) {
            Some(rest) => pending = rest,
            None => return,
        }
        wait = timing.linger;
    }
}

/// Lê e responde um pedido. Devolve o que já chegou do pedido seguinte, ou `None` quando a
/// conexão acabou (o navegador fechou, demorou demais, mandou algo inválido ou grande demais).
fn answer(
    stream: &mut TcpStream,
    shared: &Shared,
    pending: Vec<u8>,
    wait: Duration,
) -> Option<Vec<u8>> {
    let timing = shared.timing;
    stream.set_read_timeout(Some(wait)).ok()?;
    let (head, mut body) = read_head(stream, pending)?;
    stream.set_read_timeout(Some(timing.io)).ok()?;
    let head = match parse_head(&head) {
        Ok(head) => head,
        Err(status) => {
            // Sem saber onde o pedido termina não dá para continuar na mesma conexão.
            respond(stream, status, None, b"", true).ok()?;
            close_gently(stream, timing.linger);
            return None;
        }
    };
    if head.content_length > BODY_LIMIT {
        // Fechar com dados por ler faz o sistema redefinir a conexão, como o `req.destroy()`.
        return None;
    }
    let rest = read_body(stream, &mut body, head.content_length).ok()?;
    let (status, content_type, page) = if head.method != "POST" || head.target != "/callback" {
        (Status::NotFound, None, "")
    } else {
        match judge(&body, &shared.state) {
            Verdict::BadState => (
                Status::Forbidden,
                Some("text/plain; charset=utf-8"),
                "Link de login inválido.",
            ),
            Verdict::Accepted(credentials) => {
                // Um pedido atrasado, com o login já encerrado, recebe a página e mais nada.
                shared.finish(match credentials {
                    Some(credentials) => Outcome::SignedIn(credentials),
                    None => Outcome::MissingCredential,
                });
                (Status::Ok, Some("text/html; charset=utf-8"), DONE_PAGE)
            }
        }
    };
    respond(stream, status, content_type, page.as_bytes(), head.close).ok()?;
    if head.close {
        close_gently(stream, timing.linger);
        return None;
    }
    Some(rest)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Ok,
    BadRequest,
    Forbidden,
    NotFound,
    LengthRequired,
}

impl Status {
    fn line(self) -> &'static str {
        match self {
            Self::Ok => "200 OK",
            Self::BadRequest => "400 Bad Request",
            Self::Forbidden => "403 Forbidden",
            Self::NotFound => "404 Not Found",
            Self::LengthRequired => "411 Length Required",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Head {
    method: String,
    target: String,
    content_length: usize,
    /// Quem pediu quer a conexão fechada depois da resposta (`Connection: close` ou HTTP/1.0).
    close: bool,
}

/// Lê até a linha em branco que fecha os cabeçalhos, partindo do que já tinha chegado. Devolve os
/// cabeçalhos e o que veio depois deles. `None` quando a conexão fecha, demora demais ou manda
/// cabeçalho gigante.
fn read_head(stream: &mut TcpStream, mut buffer: Vec<u8>) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut chunk = [0u8; 4096];
    let mut searched = 0usize;
    loop {
        // O fim pode ter ficado dividido entre duas leituras.
        let from = searched.saturating_sub(3);
        if let Some(end) = find(&buffer[from..], b"\r\n\r\n") {
            let rest = buffer.split_off(from + end + 4);
            return Some((buffer, rest));
        }
        if buffer.len() > HEAD_LIMIT {
            return None;
        }
        searched = buffer.len();
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_head(head: &[u8]) -> Result<Head, Status> {
    let head = std::str::from_utf8(head).map_err(|_| Status::BadRequest)?;
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version), None) = (
        request.next(),
        request.next(),
        request.next(),
        request.next(),
    ) else {
        return Err(Status::BadRequest);
    };
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/1.") {
        return Err(Status::BadRequest);
    }
    // No HTTP/1.0 a conexão fecha depois da resposta, a não ser que peçam o contrário.
    let mut close = version == "HTTP/1.0";
    let mut content_length = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(Status::BadRequest)?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            // Só dígitos: `parse` sozinho aceitaria "+12".
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(Status::BadRequest);
            }
            let length = value.parse::<usize>().map_err(|_| Status::BadRequest)?;
            // Dois tamanhos diferentes é pedido malformado, não dá para saber onde o corpo acaba.
            if content_length.is_some_and(|known| known != length) {
                return Err(Status::BadRequest);
            }
            content_length = Some(length);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            // Formulário de navegador sempre manda Content-Length; corpo em pedaços fica de fora.
            return Err(Status::LengthRequired);
        } else if name.eq_ignore_ascii_case("connection") {
            for token in value.split(',').map(str::trim) {
                if token.eq_ignore_ascii_case("close") {
                    close = true;
                } else if token.eq_ignore_ascii_case("keep-alive") {
                    close = false;
                }
            }
        }
    }
    Ok(Head {
        method: method.to_owned(),
        target: target.to_owned(),
        content_length: content_length.unwrap_or(0),
        close,
    })
}

/// Completa `body` até `length` bytes. Devolve o que sobrou depois dele (começo do próximo pedido).
fn read_body(stream: &mut TcpStream, body: &mut Vec<u8>, length: usize) -> io::Result<Vec<u8>> {
    let mut chunk = [0u8; 4096];
    while body.len() < length {
        let wanted = (length - body.len()).min(chunk.len());
        let read = stream.read(&mut chunk[..wanted])?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(body.split_off(length))
}

#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    BadState,
    /// Código certo. `None` quando a página não mandou o `idToken`.
    Accepted(Option<Credentials>),
}

/// Confere o código do formulário e separa a credencial.
fn judge(body: &[u8], expected_state: &str) -> Verdict {
    // Como no `URLSearchParams.get`, vale a primeira ocorrência de cada campo.
    let mut state = None;
    let mut id_token = None;
    let mut access_token = None;
    for (name, value) in url::form_urlencoded::parse(body) {
        let slot = match &*name {
            "state" => &mut state,
            "idToken" => &mut id_token,
            "accessToken" => &mut access_token,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value.into_owned());
        }
    }
    if !same_state(
        state.unwrap_or_default().as_bytes(),
        expected_state.as_bytes(),
    ) {
        return Verdict::BadState;
    }
    let id_token = id_token.unwrap_or_default();
    if id_token.is_empty() {
        return Verdict::Accepted(None);
    }
    Verdict::Accepted(Some(Credentials {
        id_token,
        access_token: access_token.unwrap_or_default(),
    }))
}

/// Compara sem parar no primeiro byte diferente, para o tempo de resposta não revelar o código.
fn same_state(received: &[u8], expected: &[u8]) -> bool {
    if received.len() != expected.len() {
        return false;
    }
    let difference = received
        .iter()
        .zip(expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(difference) == 0
}

fn respond(
    stream: &mut TcpStream,
    status: Status,
    content_type: Option<&str>,
    body: &[u8],
    close: bool,
) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n",
        status.line(),
        body.len()
    );
    if let Some(content_type) = content_type {
        head.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// Para quando é este lado que fecha: avisa que acabou de escrever e espera o outro lado fechar.
/// Fechar direto, com algo ainda por ler, redefine a conexão e a resposta pode se perder.
fn close_gently(stream: &mut TcpStream, linger: Duration) {
    if stream.shutdown(Shutdown::Write).is_err() {
        return;
    }
    let deadline = Instant::now() + linger;
    let mut sink = [0u8; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() {
            return;
        }
        match stream.read(&mut sink) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    const ID: &str = "synthetic-id";
    const ACCESS: &str = "synthetic-access";

    fn quick() -> Timing {
        Timing {
            expiry: Duration::from_secs(60),
            poll: Duration::from_millis(5),
            io: Duration::from_secs(5),
            linger: Duration::from_secs(2),
        }
    }

    fn connect(port: u16) -> io::Result<TcpStream> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        Ok(stream)
    }

    fn request(method: &str, target: &str, body: &str) -> String {
        format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    struct Response {
        status: u16,
        head: String,
        body: String,
    }

    fn eof() -> io::Error {
        io::ErrorKind::UnexpectedEof.into()
    }

    /// Lê uma resposta HTTP pelo tamanho anunciado, sem depender de o servidor fechar a conexão.
    /// Aceita corpo em pedaços porque antivírus e filtros de anúncio que inspecionam o tráfego
    /// local (o AdGuard, por exemplo) reescrevem a resposta desse jeito no caminho.
    fn read_response(stream: &mut TcpStream) -> io::Result<Response> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut more = |buffer: &mut Vec<u8>| -> io::Result<()> {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                return Err(eof());
            }
            buffer.extend_from_slice(&chunk[..read]);
            Ok(())
        };
        let end = loop {
            if let Some(end) = find(&buffer, b"\r\n\r\n") {
                break end;
            }
            more(&mut buffer)?;
        };
        let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
        let mut rest = buffer.split_off(end + 4);
        let status = head
            .strip_prefix("HTTP/1.1 ")
            .and_then(|line| line.get(..3))
            .and_then(|code| code.parse().ok())
            .unwrap_or_else(|| panic!("resposta sem status: {head:?}"));
        let header = |name: &str| {
            head.lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.trim().to_owned())
        };
        let mut body = Vec::new();
        if header("transfer-encoding").is_some_and(|value| value.contains("chunked")) {
            loop {
                let line = loop {
                    if let Some(line) = find(&rest, b"\r\n") {
                        break line;
                    }
                    more(&mut rest)?;
                };
                let size = String::from_utf8_lossy(&rest[..line]);
                let size = usize::from_str_radix(size.split(';').next().unwrap().trim(), 16)
                    .unwrap_or_else(|_| panic!("tamanho de pedaço inválido: {size:?}"));
                while rest.len() < line + 2 + size + 2 {
                    more(&mut rest)?;
                }
                body.extend_from_slice(&rest[line + 2..line + 2 + size]);
                rest.drain(..line + 2 + size + 2);
                if size == 0 {
                    break;
                }
            }
        } else {
            let length = header("content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            while rest.len() < length {
                more(&mut rest)?;
            }
            body.extend_from_slice(&rest[..length]);
        }
        Ok(Response {
            status,
            head,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    /// Conexão nova, um pedido, uma resposta; quem fecha é o cliente, como faz o navegador.
    fn exchange(port: u16, raw: &str) -> io::Result<Response> {
        let mut stream = connect(port)?;
        stream.write_all(raw.as_bytes())?;
        read_response(&mut stream)
    }

    fn form(state: &str, id_token: &str) -> String {
        format!("state={state}&idToken={id_token}&accessToken={ACCESS}")
    }

    fn still_pending(login: &Login) {
        assert!(
            login.shared.pending(),
            "o login devia continuar esperando o navegador"
        );
    }

    /// A conexão cai sem nenhuma resposta do servidor de login.
    fn unanswered(result: io::Result<Response>) -> bool {
        // Um filtro de tráfego no caminho pode responder 5xx por conta própria quando o
        // servidor derruba a conexão; o que não pode existir é resposta do servidor de login.
        result.is_err() || result.is_ok_and(|response| response.status >= 500)
    }

    /// Com a porta fechada, ninguém mais consegue uma resposta.
    fn refuses(port: u16) {
        let raw = request("POST", "/callback", "state=x");
        assert!(
            unanswered(exchange(port, &raw)),
            "a porta {port} devia estar fechada"
        );
    }

    #[test]
    fn state_is_48_hex_chars_and_never_repeats() {
        let a = new_state().unwrap();
        let b = new_state().unwrap();
        assert_eq!(a.len(), 48);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
        assert_ne!(a, b);
    }

    #[test]
    fn login_url_matches_the_electron_app() {
        let state = "ab".repeat(24);
        let expected =
            format!("https://golive-ad118.web.app/desktop-login?port=50123&state={state}");
        assert_eq!(
            login_url("https://golive-ad118.web.app/", 50123, &state),
            expected
        );
        assert_eq!(
            login_url("https://golive-ad118.web.app", 50123, &state),
            expected
        );
        assert_eq!(
            login_url("http://localhost:5173/", 1024, "s"),
            "http://localhost:5173/desktop-login?port=1024&state=s"
        );
    }

    #[test]
    fn state_comparison_needs_same_length_and_same_bytes() {
        assert!(same_state(b"abc", b"abc"));
        assert!(!same_state(b"abd", b"abc"));
        assert!(!same_state(b"ab", b"abc"));
        assert!(!same_state(b"abcd", b"abc"));
        assert!(!same_state(b"", b"abc"));
    }

    #[test]
    fn judge_reads_the_form_like_url_search_params() {
        let state = "0f".repeat(24);
        let credentials = |id_token: &str, access_token: &str| {
            Verdict::Accepted(Some(Credentials {
                id_token: id_token.into(),
                access_token: access_token.into(),
            }))
        };
        assert_eq!(
            judge(form(&state, ID).as_bytes(), &state),
            credentials(ID, ACCESS)
        );
        // Decodifica %XX e "+", e a primeira ocorrência de cada campo é a que vale.
        let body = format!("idToken=a%2Bb+c&state={state}&idToken=outro&state=errado");
        assert_eq!(judge(body.as_bytes(), &state), credentials("a+b c", ""));
        assert_eq!(
            judge(format!("state={state}").as_bytes(), &state),
            Verdict::Accepted(None)
        );
        assert_eq!(judge(b"", &state), Verdict::BadState);
        assert_eq!(judge(b"state=short", &state), Verdict::BadState);
        assert_eq!(
            judge(format!("state={}", "z".repeat(48)).as_bytes(), &state),
            Verdict::BadState
        );
        assert_eq!(
            judge(format!("idToken={ID}").as_bytes(), &state),
            Verdict::BadState
        );
    }

    #[test]
    fn head_parser_accepts_form_posts_and_rejects_the_rest() {
        let parsed =
            parse_head(b"POST /callback HTTP/1.1\r\nHost: x\r\ncontent-LENGTH:  12 ").unwrap();
        assert_eq!(
            parsed,
            Head {
                method: "POST".into(),
                target: "/callback".into(),
                content_length: 12,
                close: false
            }
        );
        let closes = |head: &[u8]| parse_head(head).unwrap().close;
        assert!(closes(b"GET / HTTP/1.1\r\nConnection: Close"));
        assert!(closes(b"GET / HTTP/1.1\r\nConnection: x, close"));
        assert!(closes(b"GET / HTTP/1.0"));
        assert!(!closes(b"GET / HTTP/1.0\r\nConnection: keep-alive"));
        assert!(!closes(b"GET / HTTP/1.1\r\nConnection: keep-alive"));
        assert_eq!(
            parse_head(b"GET / HTTP/1.1\r\nHost: x")
                .unwrap()
                .content_length,
            0
        );
        for bad in [
            &b"POST /callback"[..],
            b"POST /callback HTTP/2",
            b"POST  /callback HTTP/1.1",
            b"POST /callback HTTP/1.1 extra",
            b"POST /callback HTTP/1.1\r\nsem-dois-pontos",
            b"POST /callback HTTP/1.1\r\nContent-Length: +12",
            b"POST /callback HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2",
            b"POST /callback HTTP/1.1\r\nHost: \xff",
        ] {
            assert_eq!(
                parse_head(bad),
                Err(Status::BadRequest),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        assert_eq!(
            parse_head(b"POST /callback HTTP/1.1\r\nTransfer-Encoding: chunked"),
            Err(Status::LengthRequired)
        );
    }

    #[test]
    fn credentials_never_show_up_in_debug_output() {
        let outcome = Outcome::SignedIn(Credentials {
            id_token: ID.into(),
            access_token: ACCESS.into(),
        });
        let text = format!("{outcome:?}");
        assert!(!text.contains(ID) && !text.contains(ACCESS), "{text}");
    }

    #[test]
    fn each_login_gets_its_own_port_and_state() {
        let a = Login::start(quick()).unwrap();
        let b = Login::start(quick()).unwrap();
        assert!(a.port > 0 && b.port > 0 && a.port != b.port);
        assert_ne!(a.state, b.state);
    }

    #[test]
    fn wrong_method_or_path_is_404_and_keeps_waiting() {
        let login = Login::start(quick()).unwrap();
        let good = form(&login.state, ID);
        for raw in [
            request("GET", "/callback", ""),
            request("POST", "/wrong", &good),
            request("POST", "/callback?x=1", &good),
            request("PUT", "/callback", &good),
        ] {
            assert_eq!(exchange(login.port, &raw).unwrap().status, 404, "{raw}");
        }
        still_pending(&login);
    }

    #[test]
    fn bad_state_is_403_and_keeps_waiting() {
        let login = Login::start(quick()).unwrap();
        for body in [
            String::new(),
            "state=short".to_owned(),
            format!("state={}", "z".repeat(48)),
            format!("idToken={ID}"),
        ] {
            let response = exchange(login.port, &request("POST", "/callback", &body)).unwrap();
            assert_eq!(response.status, 403, "{body}");
            assert_eq!(response.body, "Link de login inválido.");
        }
        still_pending(&login);
    }

    #[test]
    fn good_state_delivers_credentials_and_then_refuses_new_requests() {
        let mut login = Login::start(quick()).unwrap();
        let raw = request("POST", "/callback", &form(&login.state, ID));
        let response = exchange(login.port, &raw).unwrap();
        assert_eq!(response.status, 200);
        assert!(
            response.head.to_ascii_lowercase().contains("text/html"),
            "{}",
            response.head
        );
        assert!(response.body.contains("Pronto, você entrou"));
        assert!(!response.body.contains(ID) && !response.body.contains(ACCESS));
        assert_eq!(
            login.wait(),
            Outcome::SignedIn(Credentials {
                id_token: ID.into(),
                access_token: ACCESS.into()
            })
        );
        login.closed();
        refuses(login.port);
    }

    #[test]
    fn success_stops_listening_without_cutting_the_browser_connection() {
        let mut login = Login::start(quick()).unwrap();
        let mut browser = connect(login.port).unwrap();
        let raw = request("POST", "/callback", &form(&login.state, ID));
        browser.write_all(raw.as_bytes()).unwrap();
        // A porta já fechou e o app já recebeu a credencial; a aba ainda não leu nada.
        assert!(matches!(login.wait(), Outcome::SignedIn(_)));
        login.closed();
        thread::sleep(Duration::from_millis(300));
        let response = read_response(&mut browser).unwrap();
        assert_eq!(response.status, 200);
        assert!(response.body.contains("Pronto, você entrou"));
        assert!(response.body.trim_end().ends_with("</html>"));
        // A conexão continua de pé depois da resposta: quem fecha é o navegador.
        browser
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let waiting = browser.read(&mut [0u8; 16]);
        assert!(
            waiting.is_err_and(|e| matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            )),
            "o servidor fechou a conexão antes do navegador"
        );
    }

    #[test]
    fn one_connection_can_carry_several_requests() {
        let login = Login::start(quick()).unwrap();
        let mut browser = connect(login.port).unwrap();
        let wrong = request("POST", "/callback", "state=short");
        browser.write_all(wrong.as_bytes()).unwrap();
        assert_eq!(read_response(&mut browser).unwrap().status, 403);
        still_pending(&login);
        let right = request("POST", "/callback", &form(&login.state, ID));
        browser.write_all(right.as_bytes()).unwrap();
        assert_eq!(read_response(&mut browser).unwrap().status, 200);
        assert!(matches!(login.wait(), Outcome::SignedIn(_)));
    }

    #[test]
    fn request_split_across_packets_is_still_read() {
        let login = Login::start(quick()).unwrap();
        let raw = request("POST", "/callback", &form(&login.state, ID));
        let (first, rest) = raw.split_at(raw.find("\r\n\r\n").unwrap() + 2);
        let (second, third) = rest.split_at(10);
        let mut browser = connect(login.port).unwrap();
        for part in [first, second, third] {
            browser.write_all(part.as_bytes()).unwrap();
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(read_response(&mut browser).unwrap().status, 200);
        assert!(matches!(login.wait(), Outcome::SignedIn(_)));
    }

    #[test]
    fn missing_id_token_shows_the_page_but_fails_the_login() {
        let login = Login::start(quick()).unwrap();
        let raw = request("POST", "/callback", &form(&login.state, ""));
        assert_eq!(exchange(login.port, &raw).unwrap().status, 200);
        assert_eq!(login.wait(), Outcome::MissingCredential);
    }

    #[test]
    fn oversize_body_is_dropped_without_answer_and_keeps_waiting() {
        let login = Login::start(quick()).unwrap();
        let huge = format!("state={}&pad=", login.state) + &"x".repeat(BODY_LIMIT);
        assert!(huge.len() > BODY_LIMIT);
        assert!(
            unanswered(exchange(login.port, &request("POST", "/callback", &huge))),
            "corpo acima do limite não pode ter resposta"
        );
        still_pending(&login);

        // Exatamente no limite ainda é lido (e aceito, porque o código confere).
        let padding = BODY_LIMIT - format!("state={}&pad=", login.state).len();
        let exact = format!("state={}&pad={}", login.state, "x".repeat(padding));
        assert_eq!(exact.len(), BODY_LIMIT);
        let response = exchange(login.port, &request("POST", "/callback", &exact)).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(login.wait(), Outcome::MissingCredential);
    }

    #[test]
    fn silent_or_endless_connections_are_dropped() {
        let timing = Timing {
            io: Duration::from_millis(300),
            ..quick()
        };
        let login = Login::start(timing).unwrap();
        // Conexão que não manda nada (o navegador abre algumas de reserva).
        let mut idle = connect(login.port).unwrap();
        assert!(unanswered(read_response(&mut idle)));
        // Cabeçalho que não acaba nunca.
        let endless = format!(
            "POST /callback HTTP/1.1\r\nX-Pad: {}",
            "x".repeat(HEAD_LIMIT + 1)
        );
        assert!(unanswered(exchange(login.port, &endless)));
        // Corpo menor que o prometido.
        let short = "POST /callback HTTP/1.1\r\nContent-Length: 50\r\n\r\nstate=x";
        assert!(unanswered(exchange(login.port, short)));
        still_pending(&login);
        let raw = request("POST", "/callback", &form(&login.state, ID));
        assert_eq!(exchange(login.port, &raw).unwrap().status, 200);
    }

    #[test]
    fn cancel_ends_the_login_and_closes_the_port() {
        let mut login = Login::start(quick()).unwrap();
        login.cancel();
        assert_eq!(login.wait(), Outcome::Cancelled);
        login.closed();
        refuses(login.port);
    }

    #[test]
    fn a_new_login_cancels_the_previous_one() {
        let manager = LoginManager::default();
        let mut first = manager.begin(quick()).unwrap();
        let second = manager.begin(quick()).unwrap();
        assert_eq!(first.wait(), Outcome::Cancelled);
        assert_ne!(first.state, second.state);
        first.closed();
        still_pending(&second);

        // A credencial do primeiro link não entra no segundo login.
        let stale = request("POST", "/callback", &form(&first.state, ID));
        assert_eq!(exchange(second.port, &stale).unwrap().status, 403);
        still_pending(&second);

        manager.cancel();
        assert_eq!(second.wait(), Outcome::Cancelled);
        // Cancelar sem login em andamento não faz nada.
        manager.cancel();
    }

    #[test]
    fn a_late_callback_after_cancel_changes_nothing() {
        let login = Login::start(quick()).unwrap();
        let mut browser = connect(login.port).unwrap();
        login.cancel();
        assert_eq!(login.wait(), Outcome::Cancelled);
        let raw = request("POST", "/callback", &form(&login.state, ID));
        // A conexão foi aberta antes do cancelamento; se ainda for atendida, só mostra a página.
        if browser.write_all(raw.as_bytes()).is_ok()
            && let Ok(response) = read_response(&mut browser)
        {
            assert!(!response.body.contains(ID));
        }
        assert!(!login.shared.pending());
        assert!(login.outcome.try_recv().is_err());
    }

    #[test]
    fn login_expires_and_closes_the_port() {
        let timing = Timing {
            expiry: Duration::from_millis(150),
            ..quick()
        };
        let mut login = Login::start(timing).unwrap();
        let started = Instant::now();
        assert_eq!(login.wait(), Outcome::Expired);
        assert!(started.elapsed() >= Duration::from_millis(150));
        login.closed();
        refuses(login.port);
    }

    #[test]
    fn default_timing_keeps_the_five_minute_expiry() {
        assert_eq!(Timing::default().expiry, Duration::from_secs(300));
        assert_eq!(BODY_LIMIT, 65536);
    }

    #[test]
    fn dropping_a_login_closes_its_port() {
        let mut login = Login::start(quick()).unwrap();
        let port = login.port;
        let acceptor = login.acceptor.take().unwrap();
        drop(login);
        acceptor.join().unwrap();
        refuses(port);
    }
}
