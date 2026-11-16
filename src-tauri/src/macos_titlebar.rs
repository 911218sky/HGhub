//! macOS title bar: vertically center traffic lights using measured button geometry.
//!
//! Tauri 2 can only set `trafficLightPosition` at window creation; tao re-applies it
//! on redraw/resize/exit-fullscreen. The main window is therefore not auto-created
//! (`create: false` in tauri.macos.conf.json); setup measures buttons, computes y,
//! then builds the window with that y.

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{LogicalPosition, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";

/// Frontend title-bar height (logical px); must match `.win-titlebar` `height` in src/index.css.
const TITLEBAR_HEIGHT: f64 = 44.0;

/// System traffic-light button metrics (logical px).
#[derive(Debug, Clone, Copy, PartialEq)]
struct ButtonMetrics {
    height: f64,
    /// Distance from button bottom edge to title-bar view bottom edge.
    bottom: f64,
}

/// Probe an off-screen window for current OS traffic-light size/position.
/// Style matches `titleBarStyle: Overlay` + `hiddenTitle: true`.
fn measure_buttons(mtm: MainThreadMarker) -> Option<ButtonMetrics> {
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    // SAFETY: created on main thread; defer=true skips backing store and never shows.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            style,
            NSBackingStoreType::Buffered,
            true,
        )
    };
    // SAFETY: Retained owns the window until drop; must not also auto-release on close.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    // SAFETY: read-only parent view; not held past window drop.
    let parent = unsafe { close.superview() }?;
    // Flipped coords break tao's positioning; fall back to config fixed value.
    if parent.isFlipped() {
        return None;
    }
    let frame = close.frame();
    Some(ButtonMetrics {
        height: frame.size.height,
        bottom: frame.origin.y,
    })
}

/// `trafficLightPosition.y` that centers traffic lights in the custom title bar.
///
/// tao sets title-bar container height to `button_height + y` (top-aligned); button
/// stays `bottom` above the container bottom, so center from window top is
/// `y - bottom + height/2`. Solve for equality with `titlebar_height/2`; round to
/// whole points to avoid blurry buttons on 1x displays.
fn centered_y(metrics: ButtonMetrics, titlebar_height: f64) -> f64 {
    (titlebar_height / 2.0 - metrics.height / 2.0 + metrics.bottom).round()
}

/// Create the main window; keep config x, compute y from measured buttons (else config).
pub fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
    else {
        return Ok(());
    };

    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
    let metrics = MainThreadMarker::new().and_then(measure_buttons);
    if let Some(metrics) = metrics {
        let x = config.traffic_light_position.as_ref().map_or(14.0, |p| p.x);
        builder = builder
            .traffic_light_position(LogicalPosition::new(x, centered_y(metrics, TITLEBAR_HEIGHT)));
    }
    builder.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_buttons_in_titlebar() {
        // macOS 27 measured: 14pt buttons, 32pt default title bar, 9pt bottom inset
        let measured = ButtonMetrics { height: 14.0, bottom: 9.0 };
        let y = centered_y(measured, 44.0);
        assert_eq!(y, 24.0);
        // Back-substitute tao layout: button center = y - bottom + height/2 = title-bar center
        assert_eq!(y - measured.bottom + measured.height / 2.0, 22.0);
        assert_eq!(centered_y(measured, 52.0), 28.0);
        let other = ButtonMetrics { height: 16.0, bottom: 6.0 };
        assert_eq!(centered_y(other, 44.0), 20.0);
        // Odd deltas round to whole points
        assert_eq!(centered_y(ButtonMetrics { height: 13.0, bottom: 9.0 }, 44.0), 25.0);
    }
}
