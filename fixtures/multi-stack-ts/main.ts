// Two-stack app with a dependency edge (app → infra). Needed to exercise the
// deploy approval router: choosing "Dismiss" on `infra` must block `app` from
// planning; "Stop" must let in-flight stacks finish but start no new ones.
import { Construct } from "constructs"
import { App, TerraformStack, TerraformOutput, LocalBackend } from "__FRAMEWORK__"

class InfraStack extends TerraformStack {
  public readonly token: string
  constructor(scope: Construct, id: string) {
    super(scope, id)
    new LocalBackend(this, { path: `${id}.tfstate` })
    new TerraformOutput(this, "token", { value: "infra-token" })
    this.token = "infra-token"
  }
}

class AppStack extends TerraformStack {
  constructor(scope: Construct, id: string, infra: InfraStack) {
    super(scope, id)
    new LocalBackend(this, { path: `${id}.tfstate` })
    // Cross-stack reference creates an explicit deploy ordering: infra before app.
    new TerraformOutput(this, "from_infra", { value: infra.token })
  }
}

const app = new App()
const infra = new InfraStack(app, "infra")
new AppStack(app, "app", infra)
app.synth()
