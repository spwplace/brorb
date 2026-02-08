"""
Brainstem respiratory CPG model.

Activity-based model after Molkov et al. (2017) / Rubin et al. (2011).
Five neural populations with 10 coupled ODEs producing a three-phase
respiratory rhythm (inspiration → post-inspiration → late expiration).

Populations:
  1. pre-I/I   (excitatory, pre-BötC) — INaP bursting
  2. early-I   (inhibitory, pre-BötC) — adaptation
  3. post-I    (inhibitory, BötC)     — adaptation
  4. aug-E     (inhibitory, BötC)     — adaptation
  5. late-E    (excitatory, RTN/pFRG) — INaP bursting

State vector [10]:
  V1, V2, V3, V4, V5, hNaP1, hNaP5, mAD2, mAD3, mAD4

Uses current-based synaptic formulation. The key to oscillation:
- Pre-I/I bursts via INaP, terminates when h1 drops (slow inactivation)
- Early-I follows pre-I/I, self-terminates via adaptation (m_AD2 rises)
- As inspiration dies, post-I escapes inhibition and becomes active
- Post-I self-terminates via m_AD3, letting aug-E take over
- Aug-E self-terminates via m_AD4, and pre-I/I restarts (h1 recovered)
"""

import numpy as np


def sigmoid(V, k=10.0, V_half=0.0):
    """Firing rate sigmoid: f(V) = 1 / (1 + exp(-k*(V - V_half)))"""
    x = k * (V - V_half)
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


def default_params(target_bpm=4.0):
    """Return parameter dict tuned for the given breathing rate."""
    period = 60.0 / target_bpm  # ~15s at 4 bpm

    p = {}

    # ── Membrane time constant ────────────────────────────────────
    p["tau_m"] = 0.02

    # ── Tonic drives ──────────────────────────────────────────────
    # Crucial: tonic drives determine which populations can self-activate.
    # Post-I needs enough drive to turn on when disinhibited.
    p["d1"] = 0.0     # pre-I/I: relies entirely on INaP for excitation
    p["d2"] = -0.3    # early-I: requires pre-I/I drive
    p["d3"] = 0.3     # post-I: self-activating when disinhibited
    p["d4"] = 0.15    # aug-E: can self-activate when disinhibited
    p["d5"] = -0.5    # late-E: normally quiescent

    # ── INaP (pops 1, 5) ─────────────────────────────────────────
    # The burst condition: when h is high, g_NaP * h > threshold,
    # creating regenerative excitation. As h drops, the neuron shuts off.
    # With V equation: dV/dt = (-V + g_NaP*σ(V)*h + syn + drive) / tau_m
    # At the V=0 fixed point, σ(0, k=8, Vh=0) = 0.5
    # For burst: g_NaP * 0.5 * h_high > 0 → burst starts
    # Burst terminates when g_NaP * σ(V) * h_low + drive + syn < V_eq
    p["g_NaP1"] = 3.0
    p["g_NaP5"] = 2.5

    # h_NaP slow inactivation
    # With steep slope and low Vh, h_inf is near 0 for any V > 0,
    # so h decays monotonically during the entire burst.
    p["k_hNaP"] = -10.0   # steep inactivation
    p["Vh_hNaP"] = -0.2   # h_inf ≈ 0 whenever V > 0 (always decaying during burst)
    p["tau_hNaP"] = period * 0.6   # inspiration duration scaling

    # ── Adaptation (pops 2, 3, 4) ─────────────────────────────────
    p["g_AD2"] = 4.0     # strong adaptation to ensure self-termination
    p["g_AD3"] = 3.5
    p["g_AD4"] = 3.0

    p["k_mAD"] = 6.0     # activation slope
    p["Vh_mAD"] = 0.1    # activates when V > 0.1
    p["tau_AD2"] = period * 0.47  # early-I adapts within inspiration
    p["tau_AD3"] = period * 0.73  # post-I holds through post-I phase
    p["tau_AD4"] = period * 0.93  # aug-E holds through E2 phase

    # ── Recovery time constants ───────────────────────────────────
    # When a pop is inactive, its slow variable recovers.
    # h_NaP recovers (increases) — tau is the same (governed by h_inf)
    # m_AD recovers (decreases) — tau could be different for recovery
    # We handle this asymmetry by making tau_AD voltage-dependent
    # (faster decay when V is low). For simplicity, use same tau but
    # ensure h_inf / m_AD_inf provide strong gradient.

    # ── Synaptic weights ──────────────────────────────────────────
    # FROM pre-I/I (pop 1) — excitatory
    p["w_21"] = 1.2     # → early-I

    # FROM early-I (pop 2) — inhibitory
    p["w_32"] = -2.0    # → post-I
    p["w_42"] = -1.5    # → aug-E
    p["w_52"] = -1.0    # → late-E

    # FROM post-I (pop 3) — inhibitory
    p["w_13"] = -2.5    # → pre-I/I (strong! must kill INaP burst)
    p["w_23"] = -1.5    # → early-I
    p["w_43"] = -2.0    # → aug-E
    p["w_53"] = -0.8    # → late-E

    # FROM aug-E (pop 4) — inhibitory
    p["w_14"] = -1.5    # → pre-I/I
    p["w_24"] = -1.0    # → early-I
    p["w_34"] = -2.5    # → post-I (strong! must kill post-I)
    p["w_54"] = -0.5    # → late-E

    # FROM late-E (pop 5) — excitatory
    p["w_15"] = 0.5     # → pre-I/I

    # ── Firing rate sigmoid ───────────────────────────────────────
    p["k_f"] = 8.0
    p["Vh_f"] = 0.0      # threshold at 0

    return p


class CPGState:
    """Holds the 10 state variables as a numpy array."""

    V1, V2, V3, V4, V5 = 0, 1, 2, 3, 4
    H1, H5 = 5, 6
    M2, M3, M4 = 7, 8, 9
    N = 10

    def __init__(self, y=None):
        if y is not None:
            self.y = np.array(y, dtype=np.float64)
        else:
            # Start in late expiration (about to inspire)
            self.y = np.array([
                -0.5,   # V1: pre-I/I (inactive)
                -0.5,   # V2: early-I (inactive)
                -0.5,   # V3: post-I (inactive)
                 0.3,   # V4: aug-E (active, about to exhaust)
                -0.5,   # V5: late-E (inactive)
                 0.95,  # hNaP1: fully de-inactivated (ready to burst)
                 0.95,  # hNaP5: fully de-inactivated
                 0.02,  # mAD2: low
                 0.02,  # mAD3: low
                 0.6,   # mAD4: high (aug-E has been active, about to adapt)
            ], dtype=np.float64)


def cpg_derivatives(y, p, external_drives=None):
    """
    Compute dy/dt for the 10-variable CPG model.

    Voltage equation:
      tau_m * dV/dt = -V + I_NaP(V, h) + I_syn(f_j) + I_drive - g_AD * m_AD

    The -V term provides a unitary leak. All currents are additive.
    INaP is the only intrinsic excitatory current (pops 1, 5).
    Adaptation is the only intrinsic inhibitory current (pops 2, 3, 4).
    """
    ext = external_drives or {}
    dydt = np.zeros(10, dtype=np.float64)

    V1, V2, V3, V4, V5 = y[0], y[1], y[2], y[3], y[4]
    h1, h5 = y[5], y[6]
    m2, m3, m4 = y[7], y[8], y[9]

    # Firing rates
    kf, vf = p["k_f"], p["Vh_f"]
    f1 = sigmoid(V1, kf, vf)
    f2 = sigmoid(V2, kf, vf)
    f3 = sigmoid(V3, kf, vf)
    f4 = sigmoid(V4, kf, vf)
    f5 = sigmoid(V5, kf, vf)

    # INaP: I = g * sigmoid(V) * h  (positive feedback, gated by slow h)
    I_NaP1 = p["g_NaP1"] * sigmoid(V1, 10.0, -0.1) * h1
    I_NaP5 = p["g_NaP5"] * sigmoid(V5, 10.0, -0.1) * h5

    # Synaptic currents (current-based)
    I_syn1 = p["w_13"]*f3 + p["w_14"]*f4 + p["w_15"]*f5
    I_syn2 = p["w_21"]*f1 + p["w_23"]*f3 + p["w_24"]*f4
    I_syn3 = p["w_32"]*f2 + p["w_34"]*f4
    I_syn4 = p["w_42"]*f2 + p["w_43"]*f3
    I_syn5 = p["w_52"]*f2 + p["w_53"]*f3 + p["w_54"]*f4

    # External drives
    ext1 = p["d1"] + ext.get("drive_1", 0.0)
    ext2 = p["d2"] + ext.get("drive_2", 0.0)
    ext3 = p["d3"] + ext.get("drive_3", 0.0)
    ext4 = p["d4"] + ext.get("drive_4", 0.0)
    ext5 = p["d5"] + ext.get("drive_5", 0.0)

    # Voltage dynamics
    tau = p["tau_m"]
    dydt[0] = (-V1 + I_NaP1           + I_syn1 + ext1) / tau  # pre-I/I
    dydt[1] = (-V2 - p["g_AD2"] * m2  + I_syn2 + ext2) / tau  # early-I
    dydt[2] = (-V3 - p["g_AD3"] * m3  + I_syn3 + ext3) / tau  # post-I
    dydt[3] = (-V4 - p["g_AD4"] * m4  + I_syn4 + ext4) / tau  # aug-E
    dydt[4] = (-V5 + I_NaP5           + I_syn5 + ext5) / tau  # late-E

    # h_NaP inactivation: h_inf decreases with V (k < 0)
    h_inf1 = sigmoid(V1, p["k_hNaP"], p["Vh_hNaP"])
    h_inf5 = sigmoid(V5, p["k_hNaP"], p["Vh_hNaP"])
    dydt[5] = (h_inf1 - h1) / p["tau_hNaP"]
    dydt[6] = (h_inf5 - h5) / p["tau_hNaP"]

    # m_AD adaptation: m_inf increases with V (k > 0)
    mAD_inf2 = sigmoid(V2, p["k_mAD"], p["Vh_mAD"])
    mAD_inf3 = sigmoid(V3, p["k_mAD"], p["Vh_mAD"])
    mAD_inf4 = sigmoid(V4, p["k_mAD"], p["Vh_mAD"])
    dydt[7] = (mAD_inf2 - m2) / p["tau_AD2"]
    dydt[8] = (mAD_inf3 - m3) / p["tau_AD3"]
    dydt[9] = (mAD_inf4 - m4) / p["tau_AD4"]

    return dydt


def rk4_step(y, dt, p, external_drives=None):
    """Single RK4 integration step."""
    k1 = cpg_derivatives(y, p, external_drives)
    k2 = cpg_derivatives(y + 0.5 * dt * k1, p, external_drives)
    k3 = cpg_derivatives(y + 0.5 * dt * k2, p, external_drives)
    k4 = cpg_derivatives(y + dt * k3, p, external_drives)
    return y + (dt / 6.0) * (k1 + 2*k2 + 2*k3 + k4)
