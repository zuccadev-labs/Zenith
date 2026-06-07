import { ZenPlugins, ZenShell, ZenLogger } from "../core/cloud.ts";

/**
 * Git CLI Adapter Plugin
 * 
 * Expone la capacidad de interactuar con repositorios (Clonar repos privados, 
 * inyectar tokens, interactuar con Kubernetes configs).
 */

ZenPlugins.Git = {
  /**
   * Clona un repositorio privado inyectando de forma segura un token temporal.
   */
  clonePrivateRepo: async (repoUrl: string, token: string, destinationDir: string): Promise<string> => {
    ZenLogger.info(`[Plugin:Git] Cloning private repo into ${destinationDir}`);
    
    // Convertir https://github.com/org/repo a https://token@github.com/org/repo
    const secureUrl = repoUrl.replace("https://", `https://${token}@`);
    
    const result = await ZenShell.exec("git", [
      "clone",
      secureUrl,
      destinationDir
    ]);
    
    return result.stdout;
  },

  /**
   * Configura las credenciales locales de kubernetes para usar en CI/CD.
   * Este es un ejemplo de cómo Zen.Shell puede enrutar lógica de DevOps
   * integrando Git y Kubeconfig.
   */
  configureKubeconfig: async (clusterName: string, token: string, serverUrl: string): Promise<void> => {
    ZenLogger.info(`[Plugin:Git/K8s] Configuring kubeconfig for cluster ${clusterName}`);
    await ZenShell.exec("kubectl", ["config", "set-cluster", clusterName, `--server=${serverUrl}`, "--insecure-skip-tls-verify=true"]);
    await ZenShell.exec("kubectl", ["config", "set-credentials", "zenith-agent", `--token=${token}`]);
    await ZenShell.exec("kubectl", ["config", "set-context", "zenith-context", `--cluster=${clusterName}`, "--user=zenith-agent"]);
    await ZenShell.exec("kubectl", ["config", "use-context", "zenith-context"]);
    ZenLogger.info(`[Plugin:Git/K8s] Kubeconfig set to context: zenith-context`);
  }
};
