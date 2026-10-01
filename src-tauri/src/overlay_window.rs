//! The dictation HUD's window: how big it is, where the pill sits inside it,
//! where it goes on screen, and the hover poll that stands in for the pointer
//! events WebKit never sends it.

use crate::bundle::app_display_name;
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::windows::OVERLAY_LABEL;
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Large enough for the pill and the tooltips it raises above itself. The
/// window is transparent but not click-through, so it is kept only as big as
/// the widest tooltip actually needs.
const OVERLAY_WIDTH: f64 = 208.0;
const OVERLAY_HEIGHT: f64 = 66.0;
/// Where the pill sits inside that window, matching `overlay.css`. The tooltips
/// live above it, so the space is not shared evenly and the pill cannot simply
/// be centred -- centring would mean matching the tooltip band with dead
/// transparent window below, which swallows clicks meant for other apps.
///
/// The pill is anchored by its bottom edge so that unfolding raises its top and
/// leaves the bottom still. These have to agree with the stylesheet.
pub(crate) const OVERLAY_PILL_CX: f64 = 104.0;
const OVERLAY_PILL_BOTTOM: f64 = 2.0;
/// The resting bar's height, also from `overlay.css`.
const OVERLAY_REST_HEIGHT: f64 = 6.0;
/// A saved position refers to the resting bar's centre: that mark is what the
/// user sees and drags, whatever the capsule does when it opens.
pub(crate) const OVERLAY_PILL_CY: f64 =
    OVERLAY_HEIGHT - OVERLAY_PILL_BOTTOM - OVERLAY_REST_HEIGHT / 2.0;
/// A deliberate one-off drop, asked for once the capsule began opening upward:
/// the resting mark can sit nearer the screen edge when nothing grows below it.
///
/// It applies only while no centre has been recorded, which is what makes it
/// happen once. Reading it back gives the same answer every launch, and the
/// moment the HUD is dragged the new position is saved with a centre beside it
/// and the nudge stops applying -- so it can never accumulate.
const OVERLAY_PILL_NUDGE: f64 = 6.0;
/// Where the pill's centre sat before it had tooltips to make room for. A
/// position saved back then still refers to that layout, so it is corrected
/// when read rather than rewritten -- which keeps the correction idempotent
/// however many times the app starts.
const LEGACY_PILL_CX: f64 = 61.0;
const LEGACY_PILL_CY: f64 = 24.0;
const EDGE_MARGIN: f64 = 88.0;
/// How often the cursor is sampled while the HUD is on screen. Fast enough
/// that the pill reacts as a hover should, slow enough to be free.
const OVERLAY_HOVER_POLL_MS: u64 = 60;

/// Where the pointer is over the HUD, in the webview's own coordinates.
#[derive(Clone, Copy, Serialize)]
struct OverlayCursor {
    x: f64,
    y: f64,
}

/// Builds the dictation HUD: frameless, transparent, and never focusable.
pub(crate) fn build_overlay_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title(format!("{} listening", app_display_name()))
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    // Load-bearing: a focusable HUD would steal focus from the app being
    // dictated into, and the synthetic paste would land in Waveform. See
    // `panel::make_non_activating`, which closes the other half of this.
    .focusable(false)
    .focused(false)
    // A click on an inactive window is normally spent bringing that window
    // forward. The HUD is never coming forward, so without this its buttons
    // would need pressing twice.
    .accept_first_mouse(true)
    .visible(false)
    .build()?;

    // Load-bearing, not a nicety: without it, clicking cancel or accept brings
    // Waveform forward and the paste that follows lands in the wrong app.
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        if let Err(reason) = crate::panel::make_non_activating(&overlay) {
            eprintln!("HUD stayed an ordinary window, so clicking it will focus Waveform: {reason}");
        }
    }
    Ok(())
}

/// Positions the overlay from saved coordinates, or centres it on a screen edge.
pub(crate) fn place_overlay(overlay: &tauri::WebviewWindow, settings: &AppSettings) {
    if let (Some(x), Some(y)) = (settings.overlay_x, settings.overlay_y) {
        // What the user dragged into place is the pill, not the window around
        // it. Saved is the window's corner, so moving the pill within the
        // window has to be undone here or the pill drifts each time the layout
        // changes.
        let scale = overlay.scale_factor().unwrap_or(1.0);
        let saved_cx = settings.overlay_cx.unwrap_or(LEGACY_PILL_CX);
        let saved_cy = settings.overlay_cy.unwrap_or(LEGACY_PILL_CY);
        let nudge = if settings.overlay_cy.is_none() {
            OVERLAY_PILL_NUDGE
        } else {
            0.0
        };
        let dx = ((OVERLAY_PILL_CX - saved_cx) * scale).round() as i32;
        let dy = ((OVERLAY_PILL_CY - saved_cy - nudge) * scale).round() as i32;
        let _ = overlay.set_position(tauri::PhysicalPosition::new(x - dx, y - dy));
        return;
    }
    position_on_active_display(overlay, &settings.overlay_placement);
}

/// Puts the overlay on whichever display the pointer is on.
fn position_on_active_display(overlay: &tauri::WebviewWindow, placement: &str) {
    let Ok(Some(monitor)) = overlay.primary_monitor() else {
        return;
    };
    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();

    let width = (OVERLAY_WIDTH * scale) as i32;
    let height = (OVERLAY_HEIGHT * scale) as i32;
    let margin = (EDGE_MARGIN * scale) as i32;

    let x = position.x + (size.width as i32 - width) / 2;
    let y = if placement == "top" {
        position.y + margin
    } else {
        position.y + size.height as i32 - height - margin
    };
    let _ = overlay.set_position(tauri::PhysicalPosition::new(x, y));
}

/**
 * Reports where the pointer is over the HUD, because the HUD cannot see it.
 *
 * WebKit raises `mouseenter` and matches `:hover` from an `NSTrackingArea`
 * that only fires for the key window, or at most the active application. The
 * HUD is neither by construction: it is built non-focusable so it can never
 * steal focus from the app being dictated into, and it is on screen precisely
 * when some other app is frontmost. So no pointer event ever arrives and no
 * `:hover` rule ever matches -- the pill only expanded once a click had been
 * delivered, because clicks do reach the window under the cursor whatever app
 * owns it, and WebKit then synthesises the enter it never sent.
 *
 * A position rather than a yes/no, so the HUD can work out which control the
 * pointer is over and light it up. Emitted only when it changes.
 */
pub(crate) fn watch_overlay_hover(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<(i32, i32)> = None;
        // The window is born clickable, which is what a fresh HUD needs.
        let mut clickable = true;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(OVERLAY_HOVER_POLL_MS)).await;

            let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
                continue;
            };

            // A hidden HUD cannot be hovered, and asking a hidden window for
            // its bounds is wasted work on every tick it stays hidden.
            let visible = matches!(overlay.is_visible(), Ok(true));
            let next = if visible {
                match (
                    app.cursor_position(),
                    overlay.outer_position(),
                    overlay.outer_size(),
                    overlay.scale_factor(),
                ) {
                    (Ok(cursor), Ok(origin), Ok(size), Ok(scale)) => {
                        let x = cursor.x - origin.x as f64;
                        let y = cursor.y - origin.y as f64;
                        let inside = x >= 0.0
                            && y >= 0.0
                            && x < size.width as f64
                            && y < size.height as f64;
                        inside.then(|| {
                            ((x / scale).round() as i32, (y / scale).round() as i32)
                        })
                    }
                    _ => continue,
                }
            } else {
                None
            };

            // The window is far bigger than the pill, to hold the tooltips,
            // and a transparent window still swallows clicks. Anything outside
            // the pill is handed back to whatever is underneath.
            let over_pill = next.is_some_and(|(x, y)| {
                match app
                    .state::<AppState>()
                    .overlay_hit_region
                    .lock()
                    .ok()
                    .and_then(|region| *region)
                {
                    Some((rx, ry, rw, rh)) => {
                        let (x, y) = (f64::from(x), f64::from(y));
                        x >= rx && y >= ry && x < rx + rw && y < ry + rh
                    }
                    // Nothing measured yet. Stay clickable rather than let
                    // clicks fall through a HUD that is really there.
                    None => true,
                }
            });
            if over_pill != clickable {
                clickable = over_pill;
                let _ = overlay.set_ignore_cursor_events(!over_pill);
            }

            // Quiet while the pointer is away, but every tick while it is
            // near: the HUD decides what counts as "on the pill" by measuring
            // itself, and the pill changes size under a cursor that never
            // moved. Reporting only on change would leave it collapsed under a
            // pointer sitting right on it.
            if next.is_none() && last.is_none() {
                continue;
            }
            last = next;
            app.state::<AppState>()
                .overlay_hovered
                .store(next.is_some(), Ordering::Relaxed);
            let _ = overlay.emit_to(
                OVERLAY_LABEL,
                "overlay-cursor",
                next.map(|(x, y)| OverlayCursor {
                    x: x as f64,
                    y: y as f64,
                }),
            );
        }
    });
}
