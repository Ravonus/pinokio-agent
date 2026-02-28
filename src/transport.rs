use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

pub fn send_json_line<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    let payload = serde_json::to_string(value).context("serialize protocol payload failed")?;
    writer
        .write_all(payload.as_bytes())
        .context("write protocol payload failed")?;
    writer
        .write_all(b"\n")
        .context("write protocol newline failed")?;
    writer.flush().context("flush protocol payload failed")?;
    Ok(())
}

pub fn recv_json_line<R: BufRead, T: DeserializeOwned>(reader: &mut R) -> Result<T> {
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .context("read protocol payload failed")?;
    if read == 0 {
        anyhow::bail!("connection closed before payload");
    }
    let parsed = serde_json::from_str(line.trim_end()).context("parse protocol payload failed")?;
    Ok(parsed)
}
