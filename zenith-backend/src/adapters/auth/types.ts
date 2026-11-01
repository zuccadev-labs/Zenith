/**
 * Interfaz base para todos los adaptadores de autenticación de terceros.
 * Valida la autenticidad del payload entregado por el cliente (ej. id_token o access_token).
 * Si el token es inválido, debe lanzar una excepción (throw Error).
 */
export interface AuthAdapter {
  validateAuthData(authData: Record<string, any>, options?: Record<string, any>): Promise<void>;
}

/**
 * Adaptador Genérico / Custom (OAuth2 o cualquier flujo).
 * Útil para MCPs o modelos de negocio propios.
 */
export function createCustomAuthAdapter(validationEndpoint: string, tokenHeaderName: string = "Authorization"): AuthAdapter {
  return {
    async validateAuthData(authData: Record<string, any>) {
      if (!authData.token && !authData.access_token) {
        throw new Error("Custom Auth: missing token in authData");
      }

      const token = authData.token || authData.access_token;
      
      const res = await fetch(validationEndpoint, {
        method: "GET",
        headers: {
          [tokenHeaderName]: `Bearer ${token}`
        }
      });

      if (!res.ok) {
        throw new Error(`Custom Auth Validation Failed: ${res.status}`);
      }
      
      // Opcional: validar que el id devuelto coincida con authData.id
      const data = await res.json();
      if (authData.id && data.id && String(data.id) !== String(authData.id)) {
         throw new Error("Custom Auth: User ID mismatch.");
      }
    }
  };
}
