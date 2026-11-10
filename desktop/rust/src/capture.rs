//! Executable source/lifetime and bounded-transport model, NOT a native capture backend.
//! No web-provided HWND/PID may become a Binding without future host-side enumeration validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Window { hwnd: u64, pid: u32 },
    Monitor { handle: u64 },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioIntent {
    None,
    IncludeProcess(u32),
    ExcludeNimbo,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub source: Source,
    pub audio: AudioIntent,
    pub game_pid: Option<u32>,
}
impl Binding {
    fn valid(&self) -> bool {
        let source_valid = match self.source {
            Source::Window { hwnd, pid } => hwnd != 0 && pid != 0,
            Source::Monitor { handle } => handle != 0,
        };
        source_valid
            && !matches!(self.audio, AudioIntent::IncludeProcess(0))
            && self.game_pid != Some(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lease(u64);
#[derive(Debug)]
pub struct CaptureOwner {
    document: Option<u64>,
    next: u64,
    active: Option<(Lease, Binding)>,
}
impl Default for CaptureOwner {
    fn default() -> Self {
        Self::new()
    }
}
impl CaptureOwner {
    pub fn new() -> Self {
        Self {
            document: Some(1),
            next: 0,
            active: None,
        }
    }
    pub fn select(&mut self, generation: u64, binding: Binding) -> Result<Lease, &'static str> {
        if self.document != Some(generation) || generation == 0 || !binding.valid() {
            return Err("invalid document/source binding");
        }
        let next = self.next.checked_add(1).ok_or("session exhausted")?;
        self.next = next;
        let lease = Lease(next);
        self.active = Some((lease, binding));
        Ok(lease)
    }
    pub fn binding(&self, lease: Lease, generation: u64) -> Option<&Binding> {
        if self.document != Some(generation) {
            return None;
        }
        self.active
            .as_ref()
            .filter(|(id, _)| *id == lease)
            .map(|(_, binding)| binding)
    }
    pub fn stop(&mut self, lease: Lease, generation: u64) -> bool {
        if self.binding(lease, generation).is_none() {
            return false;
        }
        self.active = None;
        true
    }
    pub fn end_from_native(&mut self, lease: Lease) -> bool {
        if self.active.as_ref().is_none_or(|(id, _)| *id != lease) {
            return false;
        }
        self.active = None;
        true
    }
    pub fn invalidate_document(&mut self) {
        self.active = None;
        self.document = self.document.and_then(|n| n.checked_add(1));
    }
}

/// Two immutable in-flight RGBA slots; no pixel serialization to JSON.
/// This models credits only: there is no shared-memory allocation or frame producer yet.
#[derive(Debug)]
pub struct FrameBudget {
    bytes: usize,
    slots: [Option<u64>; 2],
    sequence: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameTicket {
    slot: usize,
    sequence: u64,
}
impl FrameTicket {
    pub fn slot(self) -> usize {
        self.slot
    }
}
impl FrameBudget {
    pub fn new(width: u32, height: u32, fps: u32) -> Result<Self, &'static str> {
        // Feasibility resource ceiling, not an approved product resolution cap.
        if width == 0 || height == 0 || width > 3840 || height > 2160 || !(1..=60).contains(&fps) {
            return Err("outside experiment budget");
        }
        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .and_then(|n| n.checked_mul(2))
            .ok_or("frame size overflow")?;
        Ok(Self {
            bytes,
            slots: [None, None],
            sequence: 0,
        })
    }
    pub fn max_bytes(&self) -> usize {
        self.bytes
    }
    pub fn reserve(&mut self) -> Option<FrameTicket> {
        let slot = self.slots.iter().position(Option::is_none)?;
        self.sequence = self.sequence.checked_add(1)?;
        self.slots[slot] = Some(self.sequence);
        Some(FrameTicket {
            slot,
            sequence: self.sequence,
        })
    }
    pub fn acknowledge(&mut self, ticket: FrameTicket) -> bool {
        if self.slots.get(ticket.slot) != Some(&Some(ticket.sequence)) {
            return false;
        }
        self.slots[ticket.slot] = None;
        true
    }
}
