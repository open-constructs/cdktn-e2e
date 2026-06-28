// Single-stack, provider-free app: synth/deploy/destroy run fully offline against
// a local-backend state file, so the e2e suite needs no cloud creds or network.
// `__FRAMEWORK__` is rewritten to `cdktf` or `cdktn` by scripts/provision.mjs to
// match the CLI under test across the fork boundary.
import { Construct } from "constructs"
import { App, TerraformStack, TerraformOutput, LocalBackend } from "__FRAMEWORK__"

class HelloStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id)
    new LocalBackend(this, { path: `${id}.tfstate` })
    new TerraformOutput(this, "greeting", { value: "hello from cdktn-cli-e2e" })
    new TerraformOutput(this, "secret", { value: "s3cr3t", sensitive: true })
  }
}

const app = new App()
new HelloStack(app, "hello")
app.synth()
