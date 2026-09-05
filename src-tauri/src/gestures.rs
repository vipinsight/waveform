//! Turns raw down/up events for one modifier key into dictation commands.
//!
//! Three gestures share one key:
//!   hold        press, speak, release          -> transcribe what was said
//!   double tap  tap, tap                       -> stay listening until pressed again
//!   lone tap    a single tap that goes nowhere -> discard; nothing useful was said
//!
//! A lone tap still opens the microphone, because at the moment of the first
//! tap there is no way to know whether a second is coming, and the alternative
//! is losing the first syllable of every latched session.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Start,
    Latch,
    /// A lone tap: keep listening until the speaker stops, or until the key is
    /// pressed again.
    HoldUntilSilence,
    Commit,
    Discard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Idle,
    Holding,
    TapWait,
    LatchArming,
    Latched,
    LatchReleasing,
}

pub struct GestureMachine {
    state: State,
    hold: Duration,
    double_tap: Duration,
    pressed_at: Option<Instant>,
    /// When the pending single tap stops counting as one.
    tap_deadline: Option<Instant>,
}

impl GestureMachine {
    pub fn new(hold_ms: u64, double_tap_ms: u64) -> Self {
        Self {
            state: State::Idle,
            hold: Duration::from_millis(hold_ms),
            double_tap: Duration::from_millis(double_tap_ms),
            pressed_at: None,
            tap_deadline: None,
        }
    }

    // Queried by the test suite, which is the specification both hosts share.
    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.state != State::Idle
    }

    #[allow(dead_code)]
    pub fn is_latched(&self) -> bool {
        self.state == State::Latched
    }

    pub fn key_down(&mut self, now: Instant) -> Option<Command> {
        match self.state {
            State::Idle => {
                self.pressed_at = Some(now);
                self.state = State::Holding;
                Some(Command::Start)
            }
            State::TapWait => {
                self.tap_deadline = None;
                self.state = State::LatchArming;
                None
            }
            State::Latched => {
                self.state = State::LatchReleasing;
                Some(Command::Commit)
            }
            // A repeat down while already held: the OS emits these, ignore them.
            _ => None,
        }
    }

    pub fn key_up(&mut self, now: Instant) -> Option<Command> {
        match self.state {
            State::Holding => {
                let held = self
                    .pressed_at
                    .map(|start| now.duration_since(start))
                    .unwrap_or_default();
                if held >= self.hold {
                    self.state = State::Idle;
                    return Some(Command::Commit);
                }
                self.state = State::TapWait;
                self.tap_deadline = Some(now + self.double_tap);
                None
            }
            State::LatchArming => {
                self.state = State::Latched;
                Some(Command::Latch)
            }
            State::LatchReleasing => {
                self.state = State::Idle;
                None
            }
            _ => None,
        }
    }

    /// Must be polled: a lone tap only resolves once its window closes.
    pub fn tick(&mut self, now: Instant) -> Option<Command> {
        let deadline = self.tap_deadline?;
        if now < deadline {
            return None;
        }
        self.tap_deadline = None;
        if self.state != State::TapWait {
            return None;
        }
        // Latched, so pressing the key again still stops it; the difference is
        // that this one also stops itself once the speaker pauses.
        self.state = State::Latched;
        Some(Command::HoldUntilSilence)
    }

    /// Ends a session from outside the keyboard, e.g. a click on the interface.
    pub fn stop(&mut self) -> Option<Command> {
        if self.state == State::Idle {
            return None;
        }
        self.reset();
        Some(Command::Commit)
    }

    /// Abandons a session and throws the audio away, e.g. Escape.
    pub fn cancel(&mut self) -> Option<Command> {
        if self.state == State::Idle {
            return None;
        }
        self.reset();
        Some(Command::Discard)
    }

    pub fn reset(&mut self) {
        self.state = State::Idle;
        self.tap_deadline = None;
        self.pressed_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the TypeScript suite so both hosts are held to one specification.
    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn press_and_hold_is_push_to_talk() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        assert_eq!(machine.key_down(t0), Some(Command::Start));
        assert_eq!(machine.key_up(at(t0, 1200)), Some(Command::Commit));
        assert!(!machine.is_active());
    }

    #[test]
    fn double_tap_latches_and_keeps_listening() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        assert_eq!(machine.key_down(t0), Some(Command::Start));
        assert_eq!(machine.key_up(at(t0, 80)), None);
        assert_eq!(machine.key_down(at(t0, 200)), None);
        assert_eq!(machine.key_up(at(t0, 260)), Some(Command::Latch));
        assert!(machine.is_latched());
        // Nothing ends a latched session on its own.
        assert_eq!(machine.tick(at(t0, 10_000)), None);
        assert!(machine.is_latched());
    }

    #[test]
    fn latched_session_ends_on_the_next_press_not_release() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        machine.key_up(at(t0, 80));
        machine.key_down(at(t0, 200));
        machine.key_up(at(t0, 260));

        assert_eq!(machine.key_down(at(t0, 5_000)), Some(Command::Commit));
        assert_eq!(machine.key_up(at(t0, 5_060)), None);
        assert!(!machine.is_active());
    }

    /// A one word phrase is tapped, not held. Discarding a lone tap threw away
    /// precisely the dictations people are most likely to tap.
    /// A one or two word phrase is tapped, not held. Ending at the tap window
    /// would capture a few hundred milliseconds; the session stays open.
    #[test]
    fn lone_tap_listens_until_the_speaker_stops() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        machine.key_up(at(t0, 80));
        assert_eq!(machine.tick(at(t0, 200)), None);
        assert_eq!(machine.tick(at(t0, 600)), Some(Command::HoldUntilSilence));
        assert!(machine.is_active());
    }

    #[test]
    fn a_tapped_session_can_still_be_stopped_by_the_key() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        machine.key_up(at(t0, 80));
        machine.tick(at(t0, 600));

        assert_eq!(machine.key_down(at(t0, 3_000)), Some(Command::Commit));
        assert_eq!(machine.key_up(at(t0, 3_060)), None);
        assert!(!machine.is_active());
    }

    /// Escape still throws the audio away; only the tap timeout changed.
    #[test]
    fn cancelling_still_discards() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        assert_eq!(machine.cancel(), Some(Command::Discard));
    }

    #[test]
    fn release_exactly_at_the_threshold_counts_as_a_hold() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        assert_eq!(machine.key_up(at(t0, 300)), Some(Command::Commit));
    }

    #[test]
    fn auto_repeat_does_not_restart() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        assert_eq!(machine.key_down(t0), Some(Command::Start));
        assert_eq!(machine.key_down(at(t0, 10)), None);
        assert_eq!(machine.key_down(at(t0, 20)), None);
        assert_eq!(machine.key_up(at(t0, 700)), Some(Command::Commit));
    }

    #[test]
    fn release_without_a_press_is_ignored() {
        let mut machine = GestureMachine::new(300, 420);
        assert_eq!(machine.key_up(Instant::now()), None);
    }

    #[test]
    fn stopping_commits_and_clears_the_pending_tap() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        machine.key_up(at(t0, 50));
        assert_eq!(machine.stop(), Some(Command::Commit));
        // No stray discard afterwards.
        assert_eq!(machine.tick(at(t0, 1_000)), None);
    }

    #[test]
    fn cancelling_throws_the_audio_away() {
        let mut machine = GestureMachine::new(300, 420);
        let t0 = Instant::now();
        machine.key_down(t0);
        assert_eq!(machine.cancel(), Some(Command::Discard));
    }

    #[test]
    fn stop_and_cancel_are_quiet_while_idle() {
        let mut machine = GestureMachine::new(300, 420);
        assert_eq!(machine.stop(), None);
        assert_eq!(machine.cancel(), None);
    }
}
