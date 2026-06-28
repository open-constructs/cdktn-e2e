// Lock-release fixture for issue #283. Uses the Terraform `http` backend pointed at
// the in-process mock (src/tf-http-backend.ts) via env vars the test injects, plus a
// built-in `terraform_data` resource whose local-exec `sleep` holds the state lock
// long enough during `apply` to interrupt with Ctrl-C. No provider download, no cloud.
import { Construct } from "constructs"
import { App, TerraformStack, TerraformResource, HttpBackend } from "__FRAMEWORK__"

class LockStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id)

    new HttpBackend(this, {
      address: process.env.TF_HTTP_ADDRESS!,
      lockAddress: process.env.TF_HTTP_LOCK_ADDRESS!,
      unlockAddress: process.env.TF_HTTP_UNLOCK_ADDRESS!,
      lockMethod: "LOCK",
      unlockMethod: "UNLOCK",
    })

    // terraform_data is built into Terraform >= 1.4 (no provider required). The
    // local-exec provisioner runs during apply while the lock is held. Hold via
    // `node -e setTimeout(...)` (interpreter form, no shell) so it is identical on
    // Windows/macOS/Linux — `sleep` does not exist on Windows cmd.
    const holdMs = Number(process.env.LOCK_HOLD_SECONDS ?? "25") * 1000
    const wait = new TerraformResource(this, "wait", {
      terraformResourceType: "terraform_data",
    })
    wait.addOverride("provisioner", [
      { "local-exec": { interpreter: ["node", "-e"], command: `setTimeout(()=>{}, ${holdMs})` } },
    ])
  }
}

const app = new App()
new LockStack(app, "lock")
app.synth()
