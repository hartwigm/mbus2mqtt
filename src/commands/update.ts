import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export async function cmdUpdate(): Promise<void> {
  const installDir = path.resolve(__dirname, '..', '..');
  const script = path.join(installDir, 'deploy', 'update.sh');

  if (!fs.existsSync(script)) {
    console.error(`Update script not found: ${script}`);
    process.exit(1);
  }

  try {
    execSync(`sh "${script}"`, { stdio: 'inherit', cwd: installDir });
  } catch (err: any) {
    console.error(`Update failed (exit code ${err.status})`);
    process.exit(err.status || 1);
  }
}
