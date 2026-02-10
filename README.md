# Brorb

Brorb is a browser-based, biophysically-grounded simulation and visualization of the mammalian respiratory and cardiovascular systems. It couples a neural Central Pattern Generator (CPG) with mechanical models of the lungs, gas exchange, hemodynamics, and the heart.

## Core Simulation Architecture

The simulation engine (`sim/`) is built as a modular set of coupled differential equations solved in real-time.

### 1. Brainstem Respiratory CPG (`sim/cpg.js`)
An activity-based model of the ventral respiratory column (VRC).
- **Architecture**: A five-population neural network (pre-I/I, early-I, post-I, aug-E, late-E) following Molkov et al. (2017).
- **Dynamics**: Produces a three-phase respiratory rhythm (Inspiration, Post-Inspiration, and Expiration) through synaptic inhibition and intrinsic membrane properties like INaP bursting and adaptation.
- **Modulation**: Rate is controlled via tonic drives rather than timescale adjustments, allowing for realistic physiological transitions.

### 2. Respiratory Mechanics (`sim/lungs.js`)
- **Phrenic Output**: Models phrenic motor neuron activity (Ramp-I) driven by the CPG.
- **Mechanics**: Diaphragm displacement and lung volume dynamics considering compliance and resistance.
- **Hering-Breuer Reflex**: Pulmonary stretch receptor feedback that modulates the CPG to prevent over-inflation.

### 3. Chemoreception & Gas Exchange (`sim/chemo.js`)
- **Gas Dynamics**: Tracks arterial $PaCO_2$ and $PaO_2$ levels based on metabolic production/consumption and alveolar ventilation.
- **Feedback Loops**:
  - **Central Chemoreceptors**: Slow-acting medullary response to $CO_2$.
  - **Peripheral Chemoreceptors**: Fast-acting carotid body response to both $CO_2$ and hypoxia ($O_2$).
- **$O_2$ Saturation**: Computes $SpO_2$ using the Severinghaus-Hill equation.

### 4. Cardiovascular System (`sim/heart.js` & `sim/hemodynamics.js`)
- **Cardiac Vagal Motor Neurons (CVMN)**: Integrated into the brainstem model to produce **Respiratory Sinus Arrhythmia (RSA)** as an emergent property of CPG-CVMN coupling.
- **Frank-Starling Mechanism**: Stroke volume is determined by filling time, contractility (sympathetic + ischemia), and afterload.
- **Hemodynamics**: Mean Arterial Pressure (MAP) is computed as Cardiac Output (CO) × Total Peripheral Resistance (TPR).
- **Pathophysiology**: Supports cardiac rhythms including Normal Sinus, Ventricular Tachycardia (VT), Ventricular Fibrillation (VF), and Asystole.

### 5. Autonomic Integration (`sim/autonomic.js`)
- **Baroreflex**: Senses MAP and adjusts sympathetic and vagal tones.
- **Sympathetic Tone**: Modulates heart rate, contractility, and peripheral vasoconstriction.
- **Vagal Surge**: Models the terminal bradycardia response to severe hypoxia.

## Visualization & UI

### The Orb (`vis/orb.js`)
A generative, shader-like visualization of the "vitality" of the system.
- **Respiration**: Size and color reflect lung volume and respiratory phase.
- **Vitals**: Glow intensity and color shifts (e.g., cyanosis) reflect $SpO_2$, cardiac output, and stress.
- **Particles**: Motion driven by the breathing phase and system vitality.

### Dashboard (`vis/dashboard.js`)
A skeuomorphic medical instrument panel providing full transparency into the simulation:
- **CPG Circuit**: Real-time firing rates and synaptic activity.
- **Anatomy**: Cross-sections of lung and heart mechanics.
- **ECG**: Multi-lead-style trace with rhythm-specific morphologies.
- **Vitals Readout**: Comprehensive telemetry for $PaCO_2$, $SpO_2$, MAP, HR, and Stress.
- **Strip Chart**: 10-second history of major physiological variables.

### Debug Panel (`vis/debug.js`)
A lightweight overlay for real-time monitoring of internal state variables and population activity.

## Audio Interface (`audio/`)

Brorb features **biological entrainment** via microphone input:
- **Breath Detection**: An `AudioWorklet`-based envelope follower detects external exhalations.
- **Entrainment**: Detected breaths provide excitatory drive to the CPG's post-inspiratory population, allowing the user to "breath with" or guide the simulation.

## Usage

- **Start**: Click the screen to initialize the AudioContext and microphone.
- **`v` Key**: Toggle the Dashboard view.
- **`d` Key**: Toggle the Debug Overlay.
- **Controls**: Use the dashboard to simulate metabolic stress, respiratory arrest, or myocardial infarction (Heart Attack).

## Technical Details

- **Engine**: Vanilla JavaScript (ES6 Modules).
- **Solver**: 4th-order Runge-Kutta (RK4) for neural and mechanical ODEs.
- **Rendering**: HTML5 Canvas API.
- **No Dependencies**: Runs entirely in the browser with no server-side requirements.
