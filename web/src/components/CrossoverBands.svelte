<script lang="ts">
  // Cross-over bands (HPF and LPF) integrated into PEQ section layout
  import { device } from "../state/device.svelte.ts";
  import Param from "./Param.svelte";
  let { index }: { index: number } = $props();
  const eq = $derived(device.ch(index).eq!);
  const SLOPES = [
    { v: 0, l: "Bypass" }, { v: 1, l: "BW 6" }, { v: 2, l: "BL 6" }, { v: 3, l: "BW 12" }, { v: 4, l: "BL 12" },
    { v: 5, l: "LR 12" }, { v: 6, l: "BW 18" }, { v: 7, l: "BL 18" }, { v: 8, l: "BW 24" }, { v: 9, l: "BL 24" }, { v: 10, l: "LR 24" },
  ];
  const fHz = (v: number) => (v < 1000 ? v.toFixed(0) : (v / 1000).toFixed(2));
  const commitHpf = () => device.commitHpf(index);
  const commitLpf = () => device.commitLpf(index);

  function slopeSel(e: Event, which: "hpf" | "lpf") {
    eq[which].slope = +(e.currentTarget as HTMLSelectElement).value;
    which === "hpf" ? commitHpf() : commitLpf();
  }

  function toggleHpfBypass() {
    eq.hpf.slope = eq.hpf.slope === 0 ? 8 : 0; // toggle between bypass and BW 24
    commitHpf();
  }

  function toggleLpfBypass() {
    eq.lpf.slope = eq.lpf.slope === 0 ? 8 : 0; // toggle between bypass and BW 24
    commitLpf();
  }
</script>

<div class="bands">
  <!-- HPF - High Pass Filter -->
  <div class="band" class:hpf-byp={eq.hpf.slope === 0}>
    <button class="num" style="--c:var(--ch-4)" onclick={toggleHpfBypass} title={eq.hpf.slope === 0 ? "Click to enable HPF" : "Click to bypass HPF"}>HPF</button>
    <select class="sel" value={eq.hpf.slope} onchange={(e) => slopeSel(e, "hpf")} disabled={eq.hpf.slope === 0}>
      {#each SLOPES as s (s.v)}<option value={s.v}>{s.l}</option>{/each}
    </select>
    <Param label="Freq" bind:value={eq.hpf.freqHz} min={20} max={20000} log unit={eq.hpf.freqHz < 1000 ? "Hz" : "kHz"} format={fHz} onchange={commitHpf} />
  </div>

  <!-- LPF - Low Pass Filter -->
  <div class="band" class:lpf-byp={eq.lpf.slope === 0}>
    <button class="num" style="--c:var(--ch-5)" onclick={toggleLpfBypass} title={eq.lpf.slope === 0 ? "Click to enable LPF" : "Click to bypass LPF"}>LPF</button>
    <select class="sel" value={eq.lpf.slope} onchange={(e) => slopeSel(e, "lpf")} disabled={eq.lpf.slope === 0}>
      {#each SLOPES as s (s.v)}<option value={s.v}>{s.l}</option>{/each}
    </select>
    <Param label="Freq" bind:value={eq.lpf.freqHz} min={20} max={20000} log unit={eq.lpf.freqHz < 1000 ? "Hz" : "kHz"} format={fHz} onchange={commitLpf} />
  </div>
</div>

<style>
  /* one vertical strip per band, spread across the graph width (graphic-EQ style) */
  .bands { display: flex; gap: .4rem; padding: .6rem 0 0; align-items: flex-start; }
  .band { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: .4rem;
          padding: .5rem .3rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-panel); }
  .band.hpf-byp { opacity: .45; }
  .band.lpf-byp { opacity: .45; }
  .num { width: 40px; height: 30px; padding: 0; border-radius: 6px; border: 2px solid var(--c);
         background: color-mix(in oklab, var(--c) 22%, transparent); color: var(--text); font-weight: 700; font-size: .75rem; cursor: pointer;
         display: flex; align-items: center; justify-content: center; }
  .band.hpf-byp .num { background: transparent; border-color: var(--line); }
  .band.lpf-byp .num { background: transparent; border-color: var(--line); }
  .sel { width: 100%; max-width: 88px; background: var(--bg-elev); color: var(--text); border: 1px solid var(--line);
         border-radius: 6px; font: inherit; font-size: .72rem; padding: .25rem; }
</style>
