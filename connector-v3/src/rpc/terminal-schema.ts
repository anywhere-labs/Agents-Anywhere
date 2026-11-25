/** A terminal on the wire (mirrors contracts/aa-v3/1.0/terminals.schema.json). */

import { z } from "meshcall";

const Dimension = z.number().int().min(1).max(1000);
const Generation = z.number().int().min(0);

export const TerminalControllerSchema = z.strictObject({
  client_id: z.string(),
  label: z.string(),
  connected: z.boolean(),
  since: z.string(),
});

export const TerminalInfoSchema = z.strictObject({
  id: z.string(),
  cwd: z.string(),
  shell: z.string(),
  cols: Dimension,
  rows: Dimension,
  created_at: z.string(),
  running: z.boolean(),
  exit_code: z.number().int().nullable(),
  exit_signal: z.string().nullable(),
  exited_at: z.string().nullable(),
  pid: z.number().int().nullable(),
  mode: z.enum(["pty", "pipe", "script"]),
  owner: z.enum(["user", "agent"]),
  controller: TerminalControllerSchema.nullable(),
  generation: Generation,
  viewers: z.number().int().min(0),
});
