//! CPU and memory reporting.
//!
//! Covers this process, its children, and the speech engine, which is a
//! separate process and usually the largest consumer of both. Note that under
//! Tauri the page is rendered by shared WebKit XPC services owned by launchd,
//! so that cost is not attributable here and is not counted.

use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::time::{interval, Duration};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub cpu_percent: u32,
    pub memory_mb: u32,
    pub engine_memory_mb: Option<u32>,
}

/// Samples every couple of seconds and pushes the result to the interface.
pub fn spawn_monitor(app: AppHandle, models: Arc<crate::model_server::ModelServer>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(SAMPLE_INTERVAL);
        loop {
            ticker.tick().await;

            let engine_pid = models.engine_pid().await;
            let own = sample(&descendants(std::process::id()));
            let engine = engine_pid.map(|pid| sample(&[pid]));

            let usage = ResourceUsage {
                cpu_percent: (own.0 + engine.map(|e| e.0).unwrap_or(0.0)).round() as u32,
                memory_mb: (own.1 + engine.map(|e| e.1).unwrap_or(0.0)).round() as u32,
                engine_memory_mb: engine.map(|e| e.1.round() as u32),
            };
            let _ = app.emit("resource-usage", usage);
        }
    });
}

/// Reads `%cpu` and resident memory in MB for the given pids.
fn sample(pids: &[u32]) -> (f64, f64) {
    if pids.is_empty() {
        return (0.0, 0.0);
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");

    let Ok(output) = Command::new("/bin/ps")
        .args(["-o", "%cpu=,rss=", "-p", &list])
        .stderr(Stdio::null())
        .output()
    else {
        return (0.0, 0.0);
    };

    let mut cpu = 0.0;
    let mut memory = 0.0;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        if let (Some(percent), Some(rss)) = (fields.next(), fields.next()) {
            cpu += percent.parse::<f64>().unwrap_or(0.0);
            // ps reports rss in kilobytes.
            memory += rss.parse::<f64>().unwrap_or(0.0) / 1024.0;
        }
    }
    (cpu, memory)
}

/// Walks the process table for `root` and everything descended from it.
fn descendants(root: u32) -> Vec<u32> {
    let Ok(output) = Command::new("/bin/ps")
        .args(["-eo", "pid=,ppid="])
        .stderr(Stdio::null())
        .output()
    else {
        return vec![root];
    };

    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent = fields.next()?.parse().ok()?;
            Some((pid, parent))
        })
        .collect();

    let mut found = vec![root];
    let mut index = 0;
    // Breadth-first over the parent table; the table is a snapshot, so this
    // terminates even if a process exits mid-walk.
    while index < found.len() {
        let parent = found[index];
        for (pid, ppid) in &pairs {
            if *ppid == parent && !found.contains(pid) {
                found.push(*pid);
            }
        }
        index += 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_the_root_process() {
        let found = descendants(std::process::id());
        assert!(found.contains(&std::process::id()));
    }

    #[test]
    fn samples_this_process() {
        let (_, memory) = sample(&[std::process::id()]);
        assert!(memory > 0.0, "this test process must have resident memory");
    }

    #[test]
    fn empty_pid_list_reads_zero() {
        assert_eq!(sample(&[]), (0.0, 0.0));
    }
}
