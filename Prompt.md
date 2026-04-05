You are an experienced game developer.

Build a fully playable 3D Jenga-style mobile game with realistic physics.

---

Core Requirements

- Platform: Android (APK)
- Must run independently (no browser required)
- Game must be interactive and playable (not a static demo)

---

Gameplay

- A tower made of wooden blocks (Jenga-style)
- Player can:
  - Tap/select individual blocks
  - Drag blocks out from the tower smoothly
  - Place removed blocks back on top
- The tower must:
  - React dynamically to player actions
  - Collapse naturally if balance is disturbed

---

Physics (Critical)

Use a real physics system.

Must include:

- Gravity
- Collision detection
- Friction
- Stability and weight distribution

Constraints:

- Do NOT fake physics using animations
- Do NOT freeze or lock blocks
- Blocks must move freely and respond to forces

---

Controls & Camera

- Touch-based controls:
  - Drag to move blocks
  - Swipe to rotate camera
- Camera must support:
  - Full 360° rotation
  - Zoom in/out

---

Visual Design

- Bright and playful style
- Wooden textures for blocks
- Clean, minimal UI
- No unnecessary sounds or distractions

---

Technical Requirements

- Provide a clean, working project structure
- Must work after cloning (no broken configs)
- Include:
  - .env file if needed
  - .gitignore
- Avoid requiring multiple accounts or complex setup

---

Output Format

- Provide complete source code
- Include clear setup and build instructions
- Ensure it can be built into an APK

---

Strict Failure Conditions (DO NOT DO)

- Non-functional gameplay
- Blocks that cannot be moved
- Missing or broken physics
- Build errors (e.g., missing projectId, config issues)
- Limited or fixed camera angles

---

Goal

The result must feel like a real Jenga game:
physically accurate, interactive, and satisfying to play — not a visual prototype.
