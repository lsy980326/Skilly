import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadProjectBinding } from "./binding.js";
import type { InstallationComponent } from "../../core/viewer/components.js";

/** Read only public bindings under explicit host roots, never paths supplied by stored installations. */
export function installationComponents(roots: string[]): InstallationComponent[] {
  if (roots.length > 16 || Buffer.byteLength(JSON.stringify(roots)) > 1536) throw new Error("Source project roots exceed the local control limit.");
  return roots.flatMap(root => {
    if (!isAbsolute(root)) throw new Error("Source projects require absolute paths.");
    const path = realpathSync(root), binding = loadProjectBinding(path);
    return binding.component ? [{ root: path, project_key: binding.key, repository: binding.repository, environment: binding.environment, ...binding.component }] : [];
  });
}
