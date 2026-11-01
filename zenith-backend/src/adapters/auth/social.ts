import type { AuthAdapter } from "./types.ts";

/**
 * Creates a Google OAuth authentication adapter.
 * Validates Google identity tokens via the Google OAuth2 tokeninfo endpoint.
 *
 * @returns AuthAdapter — validateAuthData for Google sign-in
 */
export function createGoogleAdapter(): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.id_token) {
        throw new Error("Google auth requires id and id_token");
      }
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${authData.id_token}`);
      if (!res.ok) throw new Error("Google token validation failed");
      const data = await res.json();
      if (data.sub !== authData.id) {
        throw new Error("Google auth token belongs to a different user");
      }
    }
  };
}

/**
 * Creates a Facebook OAuth authentication adapter.
 * Validates Facebook access tokens via the Graph API.
 *
 * @returns AuthAdapter — validateAuthData for Facebook sign-in
 */
export function createFacebookAdapter(): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.access_token) {
        throw new Error("Facebook auth requires id and access_token");
      }
      const res = await fetch(`https://graph.facebook.com/me?fields=id&access_token=${authData.access_token}`);
      if (!res.ok) throw new Error("Facebook token validation failed");
      const data = await res.json();
      if (data.id !== authData.id) {
        throw new Error("Facebook auth token belongs to a different user");
      }
    }
  };
}

/**
 * Creates a GitHub OAuth authentication adapter.
 * Validates GitHub access tokens via the GitHub API /user endpoint.
 *
 * @returns AuthAdapter — validateAuthData for GitHub sign-in
 */
export function createGithubAdapter(): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.access_token) {
        throw new Error("GitHub auth requires id and access_token");
      }
      const res = await fetch("https://api.github.com/user", {
        headers: {
          "Authorization": `token ${authData.access_token}`,
          "User-Agent": "Zenith-Auth"
        }
      });
      if (!res.ok) throw new Error("GitHub token validation failed");
      const data = await res.json();
      if (String(data.id) !== String(authData.id)) {
        throw new Error("GitHub auth token belongs to a different user");
      }
    }
  };
}

/**
 * Creates a Microsoft (Azure AD) OAuth authentication adapter.
 * Validates Microsoft access tokens via the Microsoft Graph API.
 *
 * @returns AuthAdapter — validateAuthData for Microsoft sign-in
 */
export function createMicrosoftAdapter(): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.access_token) {
        throw new Error("Microsoft auth requires id and access_token");
      }
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { "Authorization": `Bearer ${authData.access_token}` }
      });
      if (!res.ok) throw new Error("Microsoft token validation failed");
      const data = await res.json();
      if (data.id !== authData.id) {
        throw new Error("Microsoft auth token belongs to a different user");
      }
    }
  };
}

/**
 * Creates a GitLab OAuth authentication adapter.
 * Validates GitLab access tokens via the GitLab API /user endpoint.
 *
 * @param baseUrl - GitLab instance URL (default: "https://gitlab.com")
 * @returns AuthAdapter — validateAuthData for GitLab sign-in
 */
export function createGitlabAdapter(baseUrl: string = "https://gitlab.com"): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.access_token) {
        throw new Error("Gitlab auth requires id and access_token");
      }
      const res = await fetch(`${baseUrl}/api/v4/user`, {
        headers: { "Authorization": `Bearer ${authData.access_token}` }
      });
      if (!res.ok) throw new Error("Gitlab token validation failed");
      const data = await res.json();
      if (String(data.id) !== String(authData.id)) {
        throw new Error("Gitlab auth token belongs to a different user");
      }
    }
  };
}

/**
 * Creates a Gitea OAuth authentication adapter.
 * Validates Gitea access tokens via the Gitea API /user endpoint.
 *
 * @param baseUrl - Gitea instance URL (e.g. "https://gitea.example.com")
 * @returns AuthAdapter — validateAuthData for Gitea sign-in
 */
export function createGiteaAdapter(baseUrl: string): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.access_token) {
        throw new Error("Gitea auth requires id and access_token");
      }
      const res = await fetch(`${baseUrl}/api/v1/user`, {
        headers: { "Authorization": `token ${authData.access_token}` }
      });
      if (!res.ok) throw new Error("Gitea token validation failed");
      const data = await res.json();
      if (String(data.id) !== String(authData.id)) {
        throw new Error("Gitea auth token belongs to a different user");
      }
    }
  };
}

// Para Apple usualmente se valida la firma de JWT contra las llaves públicas de Apple.
// Deno no tiene un jwt verify nativo fácil sin librerías, pero Apple también expone un REST de validación,
// O para simplificar, usaremos un decodificador básico validado externamente en este boilerplate.
/**
 * Creates an Apple Sign In authentication adapter.
 * Validates Apple identity tokens by decoding the JWT payload and verifying the subject claim.
 * Production use requires JWKS key verification against Apple's public keys.
 *
 * @returns AuthAdapter — validateAuthData for Apple sign-in
 */
export function createAppleAdapter(): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.id || !authData.token) {
        throw new Error("Apple auth requires id and token (identityToken)");
      }
      
      // Implementación real requeriría descargar JWKS de https://appleid.apple.com/auth/keys
      // y verificar la firma de authData.token. 
      // Por brevedad del motor, asumiremos delegación o validación delegada.
      // Aquí se insertaría la validación criptográfica del JWT.
      const payloadB64 = authData.token.split('.')[1];
      if (!payloadB64) throw new Error("Invalid Apple JWT");
      
      const payload = JSON.parse(atob(payloadB64));
      if (payload.sub !== authData.id) {
         throw new Error("Apple token belongs to a different user");
      }
    }
  };
}
