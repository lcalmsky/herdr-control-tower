# Control Tower

A night air-traffic-control layout for [Herdr](https://herdr.dev). Every agent is an aircraft on one of four runways: TOWER (needs you), RUNWAY (working), APPROACH (done, unseen) and TAXI (idle). When an agent's status changes, its aircraft slides to the new runway. The chrome stays a quiet ink-grey console; status color is only a dot beside each runway name, and amber marks the agent you're focused on.

![Control Tower](preview.png)

## Add it

Paste this into an agent running in Herdr:

```
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/lcalmsky/herdr-control-tower
```

Before adding it, know that the `tower` mod runs programs and reads files outside its folder:

- every 2.5 s it runs `hc read` on working and blocked agents to show what their screen says;
- every 10 s it runs a small `sh` script that reads Claude Code's own transcripts under `~/.claude` (or `$CLAUDE_CONFIG_DIR`) to show context use. Only token counts and the model name leave the script, and its one temp file (`mktemp`) is removed on exit.

It makes no network calls. `RECIPE.md` is the brief to build it from scratch.

## License

MIT for the layout, theme, `tower` and `tower-rail`. `mods/tower-tabs` is modified from Herdr's shipped `tabs` mod and stays under the Apache License 2.0 (`mods/tower-tabs/LICENSE`). The bundled Nunito font is under the SIL Open Font License 1.1 (`mods/tower/fonts/OFL.txt`).
