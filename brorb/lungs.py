"""
Lung mechanics model with Hering-Breuer reflex.

Converts CPG neural output into lung volume changes and feeds
pulmonary stretch receptor signals back to the CPG.

State variables:
  - ramp_I:  Phrenic (ramp-inspiratory) motor neuron activity
  - x_diaph: Diaphragm displacement (0 = resting, >0 = contracted/descended)
  - v_lung:  Lung volume above FRC (in arbitrary units, 0 = FRC)

The ramp-I neuron integrates pre-I/I excitation and produces a
smoothly ramping output during inspiration, mimicking the phrenic
nerve discharge pattern.
"""

import numpy as np
from .cpg import sigmoid


class LungState:
    """State for the lung mechanics model."""

    RAMP_I = 0    # ramp-inspiratory motor neuron activity
    X_DIAPH = 1   # diaphragm displacement
    V_LUNG = 2    # lung volume above FRC

    N = 3

    def __init__(self, y=None):
        if y is not None:
            self.y = np.array(y, dtype=np.float64)
        else:
            self.y = np.zeros(self.N, dtype=np.float64)


def default_lung_params():
    """Return default lung mechanics parameters."""
    p = {}

    # ── Ramp-I motor neuron ───────────────────────────────────────
    p["tau_ramp"] = 0.15      # ramp-I integration time constant (s)
    p["g_ramp_exc"] = 2.0     # excitatory gain from pre-I/I to ramp-I
    p["g_ramp_inh"] = 3.0     # inhibitory gain from post-I to ramp-I (off-switch)
    p["ramp_leak"] = 0.5      # ramp-I leak rate

    # ── Diaphragm mechanics ───────────────────────────────────────
    p["tau_diaph_contract"] = 0.5   # contraction time constant (s)
    p["tau_diaph_relax"] = 2.0      # relaxation time constant (s) — slow passive recoil for smooth exhale
    p["diaph_gain"] = 1.0           # ramp-I to diaphragm force coupling

    # ── Lung compliance ───────────────────────────────────────────
    p["compliance"] = 1.0     # lung compliance (volume/pressure)
    p["resistance"] = 0.8     # airway resistance — slows volume change for smoother curves

    # ── Hering-Breuer reflex ──────────────────────────────────────
    # Only triggers at high lung volumes to prevent over-inflation.
    # Should NOT dominate phase timing — that's the CPG's job.
    p["hb_threshold"] = 0.85  # only triggers near full inflation
    p["hb_gain_postI"] = 0.3  # gentle PSR excitation to post-I
    p["hb_gain_earlyI"] = 0.15 # gentle PSR inhibition to early-I

    return p


def lung_derivatives(lung_y, cpg_y, lung_p, cpg_p):
    """
    Compute derivatives for the lung mechanics.

    Parameters
    ----------
    lung_y : ndarray (3,)
        Lung state vector [ramp_I, x_diaph, v_lung].
    cpg_y : ndarray (10,)
        CPG state vector (to read neural activities).
    lung_p : dict
        Lung parameters.
    cpg_p : dict
        CPG parameters (for sigmoid params).

    Returns
    -------
    dydt : ndarray (3,)
    """
    dydt = np.zeros(3, dtype=np.float64)

    ramp_I = lung_y[0]
    x_diaph = lung_y[1]
    v_lung = lung_y[2]

    # CPG firing rates
    f_preI = sigmoid(cpg_y[0], cpg_p["k_f"], cpg_p["Vh_f"])   # pre-I/I
    f_postI = sigmoid(cpg_y[2], cpg_p["k_f"], cpg_p["Vh_f"])  # post-I

    # ── Ramp-I motor neuron ───────────────────────────────────────
    # Excited by pre-I/I, inhibited by post-I, with leak
    ramp_drive = (lung_p["g_ramp_exc"] * f_preI
                  - lung_p["g_ramp_inh"] * f_postI
                  - lung_p["ramp_leak"] * ramp_I)
    dydt[0] = ramp_drive / lung_p["tau_ramp"]

    # Clamp ramp_I to [0, 1]
    if ramp_I <= 0 and dydt[0] < 0:
        dydt[0] = 0.0
    if ramp_I >= 1.0 and dydt[0] > 0:
        dydt[0] = 0.0

    # ── Diaphragm displacement ────────────────────────────────────
    # Active contraction driven by ramp_I, passive relaxation back to 0
    ramp_out = max(0.0, ramp_I)
    if ramp_out > 0.01:
        # Contracting phase
        target = lung_p["diaph_gain"] * ramp_out
        dydt[1] = (target - x_diaph) / lung_p["tau_diaph_contract"]
    else:
        # Relaxation phase (passive recoil)
        dydt[1] = -x_diaph / lung_p["tau_diaph_relax"]

    # ── Lung volume ───────────────────────────────────────────────
    # V_lung = compliance * x_diaph (simplified)
    # With airway resistance: dV/dt = (C * x_diaph - V) / (R * C)
    target_vol = lung_p["compliance"] * max(0.0, x_diaph)
    dydt[2] = (target_vol - v_lung) / (lung_p["resistance"] * lung_p["compliance"] + 0.01)

    return dydt


def hering_breuer_drives(lung_y, lung_p):
    """
    Compute Hering-Breuer reflex drives to feed back to CPG.

    Returns dict of external drives for cpg_derivatives().
    Pulmonary stretch receptor (PSR) activity excites post-I
    and inhibits early-I when lung volume exceeds threshold.
    """
    v_lung = lung_y[2]
    psr = max(0.0, v_lung - lung_p["hb_threshold"])

    return {
        "drive_3": lung_p["hb_gain_postI"] * psr,    # excite post-I
        "drive_2": -lung_p["hb_gain_earlyI"] * psr,  # inhibit early-I
    }


def lung_rk4_step(lung_y, dt, cpg_y, lung_p, cpg_p):
    """Single RK4 step for lung mechanics."""
    k1 = lung_derivatives(lung_y, cpg_y, lung_p, cpg_p)
    k2 = lung_derivatives(lung_y + 0.5*dt*k1, cpg_y, lung_p, cpg_p)
    k3 = lung_derivatives(lung_y + 0.5*dt*k2, cpg_y, lung_p, cpg_p)
    k4 = lung_derivatives(lung_y + dt*k3, cpg_y, lung_p, cpg_p)
    return lung_y + (dt/6.0) * (k1 + 2*k2 + 2*k3 + k4)
