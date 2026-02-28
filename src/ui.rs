use std::{
    env, fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use serde::Serialize;
use time::{Duration as TimeDuration, OffsetDateTime};

use crate::config::{AppConfig, UiConfig};

const DEFAULT_LOCAL_BROWSER_HOST: &str = "pinokio.localhost";
const LOCAL_CA_CERT_FILENAME: &str = "ui-local-ca-cert.pem";
const LOCAL_CA_KEY_FILENAME: &str = "ui-local-ca-key.pem";

#[derive(Debug, Clone, Serialize)]
pub struct UiStartReport {
    pub ok: bool,
    pub host: String,
    pub port: u16,
    pub scheme: String,
    pub url: String,
    pub configure_url: String,
    pub apps_url: String,
    pub pages_dir: String,
    pub command: String,
}

#[derive(Debug, Clone)]
struct UiTlsMaterial {
    cert_path: PathBuf,
    key_path: PathBuf,
}

#[derive(Debug, Clone)]
struct UiLocalCaMaterial {
    cert_path: PathBuf,
    key_path: PathBuf,
}

pub fn start_ui(
    config: &AppConfig,
    host_override: Option<&str>,
    port_override: Option<u16>,
    configure_mode: bool,
) -> Result<()> {
    if !config.ui.enabled {
        anyhow::bail!("ui is disabled in config (`ui.enabled=false`)");
    }

    let pages_dir = resolve_pages_dir(&config.ui.pages_dir)?;
    fs::create_dir_all(&pages_dir).with_context(|| {
        format!(
            "failed to create ui pages directory {}",
            pages_dir.display()
        )
    })?;

    ensure_cmd_available("node", "node")?;
    ensure_cmd_available("npm", "npm")?;

    if config.ui.auto_install_node_deps {
        run_shell(
            &config.ui.node_setup_command,
            &[("PINOKIO_UI_PAGES_DIR", pages_dir.to_string_lossy().as_ref())],
        )
        .with_context(|| format!("ui setup command failed: {}", config.ui.node_setup_command))?;
    }

    // Configure mode should come up fast and avoid production build noise.
    if config.ui.build_on_start && !configure_mode {
        run_shell(
            &config.ui.build_command,
            &[("PINOKIO_UI_PAGES_DIR", pages_dir.to_string_lossy().as_ref())],
        )
        .with_context(|| format!("ui build command failed: {}", config.ui.build_command))?;
    }

    let host = host_override.unwrap_or(&config.ui.host);
    let browser_host = preferred_browser_host(host);
    let requested_port = port_override.unwrap_or(config.ui.port);
    let port = select_available_port(host, requested_port)?;
    let tls = prepare_tls_material(&config.ui, browser_host.as_str()).unwrap_or_else(|error| {
        eprintln!(
            "UI TLS bootstrap failed; continuing over HTTP only: {}",
            error
        );
        None
    });
    let scheme = if tls.is_some() { "https" } else { "http" };
    let command = render_serve_command(&config.ui, host, port);

    let report = UiStartReport {
        ok: true,
        host: browser_host.clone(),
        port,
        scheme: scheme.to_string(),
        url: format!("{}://{}:{}/", scheme, browser_host, port),
        configure_url: format!("{}://{}:{}/ui/configure", scheme, browser_host, port),
        apps_url: format!("{}://{}:{}/ui/apps", scheme, browser_host, port),
        pages_dir: pages_dir.display().to_string(),
        command: command.clone(),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);

    if configure_mode {
        eprintln!(
            "Open this URL in your browser: {} (apps: {})",
            report.configure_url, report.apps_url
        );
    }

    let mut process = Command::new("sh");
    process
        .arg("-c")
        .arg(&command)
        .env(
            "PINOKIO_UI_PAGES_DIR",
            pages_dir.to_string_lossy().to_string(),
        )
        .env("PINOKIO_UI_HOST", host)
        .env("PINOKIO_UI_BROWSER_HOST", &browser_host)
        .env("PINOKIO_UI_PORT", port.to_string())
        .env("PINOKIO_UI_STRICT_PORT", "1")
        .env("PINOKIO_UI_HMR_HOST", browser_host)
        .env("PINOKIO_UI_HMR_PORT", port.to_string())
        .env(
            "PINOKIO_UI_HMR_PROTOCOL",
            if tls.is_some() { "wss" } else { "ws" },
        )
        .env("PINOKIO_UI_HTTPS", if tls.is_some() { "1" } else { "0" });
    if let Some(material) = &tls {
        process
            .env("PINOKIO_UI_TLS_CERT", material.cert_path.to_string_lossy().to_string())
            .env("PINOKIO_UI_TLS_KEY", material.key_path.to_string_lossy().to_string());
    }

    let status = process
        .status()
        .with_context(|| format!("failed to start UI serve command: {}", command))?;
    if !status.success() {
        anyhow::bail!("UI process exited with status {}", status);
    }

    Ok(())
}

fn render_serve_command(ui: &UiConfig, host: &str, port: u16) -> String {
    ui.serve_command
        .replace("{host}", host)
        .replace("{port}", &port.to_string())
}

fn run_shell(command: &str, envs: &[(&str, &str)]) -> Result<()> {
    let mut process = Command::new("sh");
    process.arg("-c").arg(command);
    for (key, value) in envs {
        process.env(key, value);
    }
    let status = process
        .status()
        .with_context(|| format!("failed to run shell command: {}", command))?;
    if !status.success() {
        anyhow::bail!("shell command failed [{}]: {}", status, command);
    }
    Ok(())
}

fn select_available_port(host: &str, requested_port: u16) -> Result<u16> {
    if is_port_available(host, requested_port) {
        return Ok(requested_port);
    }
    for offset in 1..=100 {
        let candidate = requested_port.saturating_add(offset);
        if candidate == requested_port {
            break;
        }
        if is_port_available(host, candidate) {
            return Ok(candidate);
        }
    }
    anyhow::bail!(
        "no available UI port found on host {} starting from {}",
        host,
        requested_port
    );
}

fn is_port_available(host: &str, port: u16) -> bool {
    if TcpListener::bind((host, port)).is_ok() {
        return true;
    }
    if host != "127.0.0.1" {
        return TcpListener::bind(("127.0.0.1", port)).is_ok();
    }
    false
}

fn ensure_cmd_available(bin: &str, label: &str) -> Result<()> {
    let status = Command::new(bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to run {}", bin))?;
    if !status.success() {
        anyhow::bail!("{} is not available", label);
    }
    Ok(())
}

fn resolve_pages_dir(raw: &str) -> Result<PathBuf> {
    expand_home(raw)
}

fn expand_home(raw: &str) -> Result<PathBuf> {
    if raw == "~" || raw.starts_with("~/") {
        let home = env::var("HOME").context("HOME is not set")?;
        if raw == "~" {
            return Ok(Path::new(&home).to_path_buf());
        }
        return Ok(Path::new(&home).join(raw.trim_start_matches("~/")));
    }
    Ok(PathBuf::from(raw))
}

fn prepare_tls_material(ui: &UiConfig, host: &str) -> Result<Option<UiTlsMaterial>> {
    if !ui.https_enabled {
        return Ok(None);
    }

    let cert_path = ui
        .tls_cert_path
        .as_deref()
        .map(expand_home)
        .transpose()?;
    let key_path = ui
        .tls_key_path
        .as_deref()
        .map(expand_home)
        .transpose()?;

    let (material, managed_local_tls) = match (cert_path, key_path) {
        (Some(cert), Some(key)) => (
            UiTlsMaterial {
                cert_path: cert,
                key_path: key,
            },
            false,
        ),
        (None, None) => {
            let home = env::var("HOME").context("HOME is not set")?;
            let dir = Path::new(&home).join(".pinokio-agent").join("ui-certs");
            fs::create_dir_all(&dir).with_context(|| {
                format!("failed to create UI cert directory {}", dir.display())
            })?;
            let host_token = sanitize_for_filename(host);
            (
                UiTlsMaterial {
                    cert_path: dir.join(format!("ui-{}-cert.pem", host_token)),
                    key_path: dir.join(format!("ui-{}-key.pem", host_token)),
                },
                true,
            )
        }
        _ => {
            anyhow::bail!("ui.tls_cert_path and ui.tls_key_path must both be set or both omitted");
        }
    };

    if managed_local_tls {
        let local_ca = resolve_local_ca_material(&material)?;
        ensure_local_ca_certificate(&local_ca)?;
        generate_local_tls_certificate_signed_by_ca(&material, &local_ca, host)?;
        if ui.auto_trust_local_https {
            trust_local_cert_once_best_effort(&local_ca.cert_path)?;
        }
    } else {
        if !material.cert_path.exists() || !material.key_path.exists() {
            generate_local_tls_certificate(&material, host)?;
        }
        if ui.auto_trust_local_https {
            trust_local_cert_once_best_effort(&material.cert_path)?;
        }
    }

    Ok(Some(material))
}

fn sanitize_for_filename(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "localhost".to_string()
    } else {
        trimmed.to_string()
    }
}

fn preferred_browser_host(raw: &str) -> String {
    if let Ok(explicit) = env::var("PINOKIO_UI_BROWSER_HOST") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let normalized = raw.trim();
    if normalized.eq_ignore_ascii_case("127.0.0.1")
        || normalized.eq_ignore_ascii_case("0.0.0.0")
        || normalized.eq_ignore_ascii_case("::1")
        || normalized.eq_ignore_ascii_case("::")
        || normalized.eq_ignore_ascii_case("localhost")
    {
        return DEFAULT_LOCAL_BROWSER_HOST.to_string();
    }
    if normalized.is_empty() {
        return DEFAULT_LOCAL_BROWSER_HOST.to_string();
    }
    normalized.to_string()
}

fn resolve_local_ca_material(material: &UiTlsMaterial) -> Result<UiLocalCaMaterial> {
    let cert_parent = material
        .cert_path
        .parent()
        .context("managed TLS cert path has no parent directory")?;
    let key_parent = material
        .key_path
        .parent()
        .context("managed TLS key path has no parent directory")?;
    let ca_dir = if cert_parent == key_parent {
        cert_parent.to_path_buf()
    } else {
        anyhow::bail!(
            "managed TLS cert/key paths must share a parent directory (cert={}, key={})",
            cert_parent.display(),
            key_parent.display()
        );
    };
    Ok(UiLocalCaMaterial {
        cert_path: ca_dir.join(LOCAL_CA_CERT_FILENAME),
        key_path: ca_dir.join(LOCAL_CA_KEY_FILENAME),
    })
}

fn ensure_local_ca_certificate(local_ca: &UiLocalCaMaterial) -> Result<()> {
    let have_files = local_ca.cert_path.exists() && local_ca.key_path.exists();
    if have_files {
        let cert_text = fs::read_to_string(&local_ca.cert_path)
            .with_context(|| format!("failed to read {}", local_ca.cert_path.display()))?;
        let key_text = fs::read_to_string(&local_ca.key_path)
            .with_context(|| format!("failed to read {}", local_ca.key_path.display()))?;
        if CertificateParams::from_ca_cert_pem(&cert_text).is_ok() && KeyPair::from_pem(&key_text).is_ok() {
            return Ok(());
        }
    }

    generate_local_ca_certificate(local_ca)
}

fn load_local_ca_issuer(local_ca: &UiLocalCaMaterial) -> Result<(rcgen::Certificate, KeyPair)> {
    let cert_text = fs::read_to_string(&local_ca.cert_path)
        .with_context(|| format!("failed to read {}", local_ca.cert_path.display()))?;
    let key_text = fs::read_to_string(&local_ca.key_path)
        .with_context(|| format!("failed to read {}", local_ca.key_path.display()))?;
    let ca_params =
        CertificateParams::from_ca_cert_pem(&cert_text).context("failed to parse local CA certificate")?;
    let ca_key = KeyPair::from_pem(&key_text).context("failed to parse local CA private key")?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .context("failed to reconstruct local CA certificate")?;
    Ok((ca_cert, ca_key))
}

fn generate_local_ca_certificate(local_ca: &UiLocalCaMaterial) -> Result<()> {
    if let Some(parent) = local_ca.cert_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    if let Some(parent) = local_ca.key_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let mut params = CertificateParams::new(Vec::<String>::new())
        .context("failed to initialize local CA certificate parameters")?;
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::days(2);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(3650);
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.use_authority_key_identifier_extension = true;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "pinokio-agent-ui-local-ca");
    params.distinguished_name = name;

    let ca_key = KeyPair::generate().context("failed to generate local CA private key")?;
    let ca_cert = params
        .self_signed(&ca_key)
        .context("failed to generate local CA certificate")?;

    fs::write(&local_ca.cert_path, ca_cert.pem())
        .with_context(|| format!("failed to write {}", local_ca.cert_path.display()))?;
    fs::write(&local_ca.key_path, ca_key.serialize_pem())
        .with_context(|| format!("failed to write {}", local_ca.key_path.display()))?;
    Ok(())
}

fn generate_local_tls_certificate(material: &UiTlsMaterial, host: &str) -> Result<()> {
    let mut sans = vec!["localhost".to_string()];
    if !host.trim().is_empty() && !sans.iter().any(|value| value == host) {
        sans.push(host.to_string());
    }

    let mut params = CertificateParams::new(sans)
        .context("failed to initialize local TLS certificate parameters")?;
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::days(2);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(397);
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "pinokio-agent-ui");
    params.distinguished_name = name;
    if let Ok(loopback_v4) = "127.0.0.1".parse() {
        params.subject_alt_names.push(SanType::IpAddress(loopback_v4));
    }
    if let Ok(loopback_v6) = "::1".parse() {
        params.subject_alt_names.push(SanType::IpAddress(loopback_v6));
    }
    if let Ok(host_ip) = host.parse() {
        params.subject_alt_names.push(SanType::IpAddress(host_ip));
    }

    let key_pair = KeyPair::generate().context("failed to generate TLS private key")?;
    let cert = params
        .self_signed(&key_pair)
        .context("failed to generate self-signed TLS certificate")?;

    if let Some(parent) = material.cert_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    if let Some(parent) = material.key_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    fs::write(&material.cert_path, cert.pem())
        .with_context(|| format!("failed to write {}", material.cert_path.display()))?;
    fs::write(&material.key_path, key_pair.serialize_pem())
        .with_context(|| format!("failed to write {}", material.key_path.display()))?;
    Ok(())
}

fn generate_local_tls_certificate_signed_by_ca(
    material: &UiTlsMaterial,
    local_ca: &UiLocalCaMaterial,
    host: &str,
) -> Result<()> {
    let (ca_cert, ca_key) = load_local_ca_issuer(local_ca)?;

    let mut sans = vec!["localhost".to_string()];
    if !host.trim().is_empty() && !sans.iter().any(|value| value == host) {
        sans.push(host.to_string());
    }

    let mut params = CertificateParams::new(sans)
        .context("failed to initialize local TLS certificate parameters")?;
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::days(2);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(397);
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "pinokio-agent-ui");
    params.distinguished_name = name;
    if let Ok(loopback_v4) = "127.0.0.1".parse() {
        params.subject_alt_names.push(SanType::IpAddress(loopback_v4));
    }
    if let Ok(loopback_v6) = "::1".parse() {
        params.subject_alt_names.push(SanType::IpAddress(loopback_v6));
    }
    if let Ok(host_ip) = host.parse() {
        params.subject_alt_names.push(SanType::IpAddress(host_ip));
    }

    let key_pair = KeyPair::generate().context("failed to generate TLS private key")?;
    let cert = params
        .signed_by(&key_pair, &ca_cert, &ca_key)
        .context("failed to generate local TLS certificate signed by local CA")?;

    if let Some(parent) = material.cert_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    if let Some(parent) = material.key_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    fs::write(&material.cert_path, cert.pem())
        .with_context(|| format!("failed to write {}", material.cert_path.display()))?;
    fs::write(&material.key_path, key_pair.serialize_pem())
        .with_context(|| format!("failed to write {}", material.key_path.display()))?;
    Ok(())
}

fn trust_local_cert_once_best_effort(cert_path: &Path) -> Result<()> {
    let marker_path = cert_path.with_extension("trusted");
    let cert_marker = fs::read_to_string(cert_path).unwrap_or_default();
    if marker_path.exists() {
        if let Ok(existing_marker) = fs::read_to_string(&marker_path) {
            if existing_marker == cert_marker {
                return Ok(());
            }
        }
    }
    if trust_local_certificate(cert_path) {
        let _ = fs::write(marker_path, cert_marker.as_bytes());
    }
    Ok(())
}

fn trust_local_certificate(cert_path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let keychain = env::var("HOME")
            .ok()
            .map(|home| format!("{}/Library/Keychains/login.keychain-db", home))
            .unwrap_or_else(|| "login.keychain-db".to_string());
        if let Ok(status) = Command::new("security")
            .arg("add-trusted-cert")
            .arg("-d")
            .arg("-r")
            .arg("trustRoot")
            .arg("-p")
            .arg("ssl")
            .arg("-k")
            .arg(&keychain)
            .arg(cert_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            if status.success() {
                return true;
            }
        }
        return Command::new("security")
            .arg("add-trusted-cert")
            .arg("-d")
            .arg("-r")
            .arg("trustAsRoot")
            .arg("-p")
            .arg("ssl")
            .arg("-k")
            .arg(keychain)
            .arg(cert_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(target_os = "windows")]
    {
        return Command::new("certutil")
            .arg("-user")
            .arg("-addstore")
            .arg("Root")
            .arg(cert_path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(status) = Command::new("trust")
            .arg("anchor")
            .arg("--store")
            .arg(cert_path)
            .status()
        {
            if status.success() {
                return true;
            }
        }
        false
    }
}
