/**
 * zen deploy — Empaqueta y despliega el binario Zenith.
 *
 * Modos:
 *   zen deploy            → compila + despliega al target configurado en zen.config.ts
 *   zen deploy --target k8s   → genera manifiestos Kubernetes
 *   zen deploy --target docker → construye imagen Docker y la publica
 *   zen deploy --dry-run  → muestra el plan sin ejecutar
 */
import { parseArgs } from "@std/cli/parse-args";
import { join, fromFileUrl } from "@std/path";
import { spinner } from "./_utils.ts";

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    string:  ["target","tag","registry","namespace"],
    boolean: ["dry-run","push"],
    default: { target: "local", tag: "latest" },
  });

  const cwd           = Deno.cwd();
  const configPath    = join(cwd, "zen.config.ts");
  const coreEntry     = fromFileUrl(new URL("../../zenith-backend/src/mod.ts", import.meta.url));
  const outputBin     = join(cwd, "zenith-server");
  const dockerImage   = `${parsed.registry ?? "registry.io/zenith"}:${parsed.tag}`;

  if (parsed["dry-run"]) {
    console.log(`\n🔍 Dry-run — Plan de despliegue (target: ${parsed.target})\n`);
    console.log(`   Config:     ${configPath}`);
    console.log(`   Entry:      ${coreEntry}`);
    console.log(`   Output:     ${outputBin}`);
    console.log(`   Target:     ${parsed.target}`);
    if (parsed.target === "docker") console.log(`   Imagen:     ${dockerImage}`);
    console.log("\n   (--dry-run activo: no se ejecutó nada)");
    return;
  }

  console.log(`\n🚀 Zenith Deploy — Target: ${parsed.target.toUpperCase()}\n`);

  // ── Paso 1: Compilar binario ───────────────────────────────────────────────

  const spin1 = spinner("Compilando binario (Deno AOT)...");
  const compileProc = new Deno.Command(Deno.execPath(), {
    args: [
      "compile", "-A", "--no-check",
      "--output", outputBin,
      "--target", Deno.build.target,
      coreEntry,
    ],
    stdout: "piped", stderr: "piped",
  });
  const compileResult = await compileProc.output();
  spin1.stop(compileResult.success);

  if (!compileResult.success) {
    const err = new TextDecoder().decode(compileResult.stderr);
    console.error("❌ Compilación fallida:\n" + err);
    Deno.exit(1);
  }

  // ── Paso 2: Target-specific deployment ────────────────────────────────────

  if (parsed.target === "local") {
    console.log(`\n✅ Binario listo: ${outputBin}`);
    console.log(`   Ejecutar con: ./zenith-server`);
    return;
  }

  if (parsed.target === "docker") {
    const spin2 = spinner(`Construyendo imagen Docker ${dockerImage}...`);
    const dockerBuild = new Deno.Command("docker", {
      args: ["build", "-t", dockerImage, "-f", join(cwd, "Dockerfile"), cwd],
      stdout: "inherit", stderr: "inherit",
    });
    const buildResult = await dockerBuild.output();
    spin2.stop(buildResult.success);

    if (!buildResult.success) { console.error("❌ Docker build fallido."); Deno.exit(1); }

    if (parsed.push) {
      const spin3 = spinner(`Publicando ${dockerImage}...`);
      const pushResult = await new Deno.Command("docker", {
        args: ["push", dockerImage], stdout: "inherit", stderr: "inherit",
      }).output();
      spin3.stop(pushResult.success);
    }

    console.log(`\n✅ Imagen lista: ${dockerImage}`);
    return;
  }

  if (parsed.target === "k8s") {
    const namespace = parsed.namespace ?? "zenith";
    const manifest  = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zenith-server
  namespace: ${namespace}
  labels:
    app: zenith
spec:
  replicas: 3
  selector:
    matchLabels: { app: zenith }
  template:
    metadata:
      labels: { app: zenith }
    spec:
      containers:
      - name: zenith
        image: ${dockerImage}
        ports:
        - containerPort: 3000
        env:
        - name: ZENITH_MASTER_KEY
          valueFrom:
            secretKeyRef: { name: zenith-secrets, key: master-key }
        - name: ZENITH_DATABASE_URI
          valueFrom:
            secretKeyRef: { name: zenith-secrets, key: database-uri }
        resources:
          requests: { cpu: "500m", memory: "512Mi" }
          limits:   { cpu: "2",    memory: "2Gi"  }
        readinessProbe:
          httpGet: { path: /healthz, port: 3000 }
          initialDelaySeconds: 10
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: zenith-service
  namespace: ${namespace}
spec:
  selector: { app: zenith }
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
`.trim();

    const manifestPath = join(cwd, "k8s", "zenith-deploy.yaml");
    await Deno.mkdir(join(cwd, "k8s"), { recursive: true });
    await Deno.writeTextFile(manifestPath, manifest);
    console.log(`\n✅ Manifiesto Kubernetes generado: ${manifestPath}`);
    console.log(`   Aplicar con: kubectl apply -f ${manifestPath}`);
    return;
  }

  console.log(`❌ Target desconocido: ${parsed.target}. Usa: local | docker | k8s`);
}
