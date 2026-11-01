/**
 * CRM Models Registry
 * Centraliza las definiciones de esquemas de Parse y su enrutamiento inteligente (Smart Routing).
 */

export function registerCRMModels(Zen: any) {
  // 1. Core CRM Models (almacenados en MongoDB/Postgres por defecto)
  Zen.Cloud.defineSchema?.("Contact", {
    name:    { type: "String", required: true },
    email:   { type: "String", required: true },
    phone:   { type: "String" },
    company: { type: "String" },
    title:   { type: "String" },
    tags:    { type: "Array",  defaultValue: [] },
    source:  { type: "String", defaultValue: "manual" },
    score:   { type: "Number", defaultValue: 0 },
    notes:   { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Lead", {
    contact:    { type: "Pointer", targetClass: "Contact", required: true }, // Parse Pointer
    owner:      { type: "Pointer", targetClass: "_User",   required: true },
    stage:      { type: "String",  defaultValue: "new" },
    value:      { type: "Number",  defaultValue: 0 },
    currency:   { type: "String",  defaultValue: "USD" },
    probability:{ type: "Number",  defaultValue: 10 },
    closeDate:  { type: "Date" },
    lostReason: { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Deal", {
    title:     { type: "String",  required: true },
    contacts:  { type: "Relation", targetClass: "Contact" },               // Parse Relation (1 a muchos)
    owner:     { type: "Pointer", targetClass: "_User",    required: true },
    pipeline:  { type: "String",  defaultValue: "default" },
    stage:     { type: "String",  required: true },
    amount:    { type: "Number",  defaultValue: 0 },
    currency:  { type: "String",  defaultValue: "USD" },
    closeDate: { type: "Date" },
    wonAt:     { type: "Date" },
    lostAt:    { type: "Date" },
  });

  Zen.Cloud.defineSchema?.("Account", {
    name:      { type: "String", required: true },
    industry:  { type: "String" },
    size:      { type: "Number" },
    revenue:   { type: "Number" },
    website:   { type: "String" },
    contacts:  { type: "Relation", targetClass: "Contact" } // Parse Relation
  });

  // 2. Stream Data Models (ScyllaDB Smart Routing)
  // Nota: Zenith interceptará 'x-database' en el pipeline para enrutar a ScyllaDB si está configurado.
  Zen.Cloud.defineSchema?.("Activity", {
    type:        { type: "String", required: true },
    subject:     { type: "String", required: true },
    contact:     { type: "Pointer", targetClass: "Contact" },
    deal:        { type: "Pointer", targetClass: "Deal" },
    owner:       { type: "Pointer", targetClass: "_User" },
    date:        { type: "Date" },
    notes:       { type: "String", defaultValue: "" },
    outcome:     { type: "String" },
  }, { "x-database": "scylla" } as any); // Hint para Smart Routing

  // 3. AI Insights Models (VectorDB Smart Routing)
  Zen.Cloud.defineSchema?.("CRM_Insight", {
    entityId:    { type: "String", required: true }, // Puede referenciar a un Contact o Deal
    entityType:  { type: "String", required: true },
    vector_data: { type: "Array", required: true },  // Almacenado en Qdrant/Milvus
    sentiment:   { type: "String" },
    summary:     { type: "String" }
  }, { "x-database": "vector" } as any); // Hint para Smart Routing
}
