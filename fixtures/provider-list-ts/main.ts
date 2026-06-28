// Fixture for `cdktn provider list`: declares two small real providers
// (hashicorp/random, hashicorp/null) in cdktf.json. provider list reads the config
// directly — no `cdktn get`/download — so the providers stay tiny and offline-safe.
// The app itself is a no-op (provider list doesn't synth).
import { Construct } from "constructs"
import { App, TerraformStack } from "__FRAMEWORK__"

class ProvidersStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id)
  }
}

const app = new App()
new ProvidersStack(app, "providers")
app.synth()
