/**
 * @module @zenith/adapters/billing/types
 * Estándar Corporativo para Adaptadores de Facturación (Pagos) en Zenith.
 * 
 * Permite inyectar proveedores como Stripe, PayPal o Web3 en el BillingTrait.
 */

export interface BillingAdapter {
  /**
   * Inicializa la conexión con el proveedor de pagos (ej. inicializar SDK de Stripe).
   */
  init(config: Record<string, any>): Promise<void>;

  /**
   * Crea un cliente/customer en el proveedor de pagos y devuelve su ID externo.
   * @param userId El objectId del usuario en Zenith
   * @param data Datos adicionales (email, nombre)
   * @returns El ID del cliente en el proveedor (ej. stripe_cus_123)
   */
  createCustomer(userId: string, data: { email?: string; name?: string }): Promise<string>;

  /**
   * Suscribe a un cliente a un plan específico.
   * @param customerId ID del cliente en el proveedor
   * @param planId ID del plan/producto en el proveedor
   * @returns Datos de la suscripción creada
   */
  createSubscription(customerId: string, planId: string): Promise<{ subscriptionId: string; status: string; currentPeriodEnd: Date }>;

  /**
   * Procesa un cobro único a una tarjeta o fuente de fondos guardada.
   * @param customerId ID del cliente en el proveedor
   * @param amount Cantidad a cobrar (en centavos o unidad mínima del proveedor)
   * @param currency Moneda (ej. "usd")
   * @param description Descripción del cargo (aparece en el estado de cuenta)
   * @returns El ID de la transacción
   */
  charge(customerId: string, amount: number, currency: string, description?: string): Promise<string>;

  /**
   * Reporta uso de una métrica para facturación por consumo (Metered Billing).
   * Fundamental para SaaS (ej. cobrar por tokens de IA).
   * @param subscriptionId ID de la suscripción (o customerId según el proveedor)
   * @param metricName Nombre de la métrica a cobrar (ej. "ai_input_tokens")
   * @param quantity Cantidad consumida
   */
  reportUsage(subscriptionId: string, metricName: string, quantity: number): Promise<void>;

  /**
   * Verifica la firma de un Webhook entrante para evitar fraudes.
   * @param payload El cuerpo de la petición (JSON en texto crudo)
   * @param signature La firma criptográfica recibida en los headers
   * @returns true si el webhook es legítimo
   */
  verifyWebhookSignature(payload: string, signature: string): boolean;
}
