import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import pLimit from "p-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NEW_RELIC_API_KEY = process.env.NEW_RELIC_API_KEY;
const ACCOUNT_ID = process.env.ACCOUNT_ID;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(path.resolve(), "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(path.resolve(), "public/index.html"));
});

// Función genérica para consultar GraphQL de New Relic
async function graphqlQuery(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s
  try {
    const resp = await fetch("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": NEW_RELIC_API_KEY,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });
    return await resp.json();
  } catch (err) {
    console.error("Error graphqlQuery:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Obtener entidad por GUID (name + type)
async function getEntityByGuid(guid) {
  if (!guid) return { name: null, type: null };
  const query = `{
    actor {
      entity(guid: "${guid}") {
        name
        type
      }
    }
  }`;
  try {
    const data = await graphqlQuery(query);
    return data?.data?.actor?.entity || { name: null, type: null };
  } catch (err) {
    console.error("Error getEntityByGuid:", err);
    return { name: null, type: null };
  }
}

// Formatea un term en texto legible
function formatTerm(term) {
  if (!term) return "";
  const opMap = {
    "ABOVE": "above",
    "ABOVE_OR_EQUALS": "above or equals",
    "BELOW": "below",
    "BELOW_OR_EQUALS": "below or equals",
    "GREATER_THAN": "greater than",
    "LESS_THAN": "less than"
  };
  const priority = (term.priority || "").toString().toLowerCase();
  const prLabel = priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : "";
  const operator = opMap[term.operator] || (term.operator || "");
  const threshold = term.threshold ?? "";
  let durationLabel = "";
  const dur = Number(term.thresholdDuration || 0);
  if (dur >= 60 && dur % 60 === 0) {
    durationLabel = `${dur / 60} minutes`;
  } else if (dur > 0) {
    durationLabel = `${dur} seconds`;
  }
  const occ = term.thresholdOccurrences ?? "";
  const parts = [];
  if (prLabel) parts.push(`${prLabel}:`);
  parts.push(`${operator} ${threshold}`);
  if (durationLabel) parts.push(`for at least ${durationLabel}`);
  if (occ) parts.push(`(${occ} occurrences)`);
  return parts.join(" ");
}

// Extrae GUIDs desde una query NRQL
function extractGuidsFromNrql(nrqlQuery) {
  if (!nrqlQuery) return [];
  const regex = /(?:entity\.?guid|guid|entityGuid)\s*(?:IN\s*\(|=)\s*['"]([^'"]+)['"]/gi;
  const matches = [];
  let match;
  while ((match = regex.exec(nrqlQuery)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

// Enriquecer condiciones: añade realEntity y termsText
async function enrichConditions(conditions) {
  if (!Array.isArray(conditions)) return conditions;

  const limit = pLimit(5); // máximo 5 solicitudes concurrentes

  return await Promise.all(
    conditions.map(cond => limit(async () => {
      const guids = extractGuidsFromNrql(cond.nrql?.query);
      const guid = guids.length > 0 ? guids[0] : (cond.entity?.guid || null);

      // Fallback si getEntityByGuid falla
      let realEntity = {
        guid: guid || null,
        name: cond.entity?.name || "unknown",
        type: cond.entity?.type || "unknown"
      };

      if (guid) {
        try {
          const entityData = await getEntityByGuid(guid);
          if (entityData) {
            realEntity = {
              guid,
              name: entityData.name || cond.entity?.name || "unknown",
              type: entityData.type || cond.entity?.type || "unknown"
            };
          }
        } catch (err) {
          // registrar solo una vez por error
          console.error("Error getEntityByGuid:", err.message || err);
        }
      }

      cond.realEntity = realEntity;

      cond.termsText = Array.isArray(cond.terms)
        ? cond.terms.map(formatTerm).join(" ; ")
        : "";

      return cond;
    }))
  );
}



async function getAllPolicies() {
  let policies = [];
  let cursor = null;
  do {
    const q = `{
      actor {
        account(id: ${ACCOUNT_ID}) {
          alerts {
            policiesSearch(cursor: ${cursor ? `"${cursor}"` : null}) {
              policies { id name }
              nextCursor
            }
          }
        }
      }
    }`;
    const resp = await graphqlQuery(q);
    const res = resp?.data?.actor?.account?.alerts?.policiesSearch;
    if (!res) break;
    policies = policies.concat(res.policies);
    cursor = res.nextCursor;
  } while (cursor);
  return policies; // array de objetos { id, name }
}

app.get("/alerts-all", async (req, res) => {
  try {
    // 1. Obtener todas las policies y construir un map
    const allPolicies = await getAllPolicies();
    const policyMap = {};
    allPolicies.forEach(p => {
      policyMap[p.id] = p.name;
    });

    // 2. Obtener todas las condiciones como antes
    let allConditions = [];
    let cursor = null;
    do {
      const query = `{
        actor {
          account(id: ${ACCOUNT_ID}) {
            alerts {
              nrqlConditionsSearch(cursor: ${cursor ? `"${cursor}"` : null}) {
                nrqlConditions {
                  id
                  name
                  description
                  enabled
                  type
                  runbookUrl
                  policyId
                  nrql { query }
                  terms {
                    operator
                    threshold
                    priority
                    thresholdDuration
                    thresholdOccurrences
                  }
                  entity { name type guid }
                }
                nextCursor
              }
            }
          }
        }
      }`;
      const data = await graphqlQuery(query);
      const result = data?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
      if (!result) break;
      allConditions = allConditions.concat(result.nrqlConditions);
      cursor = result.nextCursor;
    } while (cursor);

    // 3. Enriquecer condiciones con policyName desde el map
    const enriched = await enrichConditions(allConditions);
    const withPolicyName = enriched.map(cond => {
      const pid = cond.policyId;
      return {
        ...cond,
        policyName: policyMap[pid] || null
      };
    });

    res.json(withPolicyName);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener alertas con nombres de policy" });
  }
});
// Endpoint: alertas por policyId
// Endpoint: alertas por policyId
app.post("/alerts", async (req, res) => {
  const { policyId } = req.body;
  if (!policyId) return res.status(400).json({ error: "policyId es requerido" });

  try {
    // 1️⃣ Obtener el nombre de la policy
    const allPolicies = await getAllPolicies();
    const policyMap = {};
    allPolicies.forEach(p => { policyMap[p.id] = p.name; });
    const policyName = policyMap[policyId] || null;

    // 2️⃣ Obtener las condiciones
    let allConditions = [];
    let cursor = null;

    do {
      const query = `
      {
        actor {
          account(id: ${ACCOUNT_ID}) {
            alerts {
              nrqlConditionsSearch(searchCriteria: { policyId: "${policyId}" }, cursor: ${cursor ? `"${cursor}"` : null}) {
                nrqlConditions {
                  id
                  name
                  description
                  enabled
                  type
                  runbookUrl
                  policyId
                  nrql { query }
                  terms {
                    operator
                    threshold
                    priority
                    thresholdDuration
                    thresholdOccurrences
                  }
                  entity { name type guid }
                }
                nextCursor
              }
            }
          }
        }
      }
      `;

      const data = await graphqlQuery(query);
      const result = data?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
      if (!result) break;

      allConditions = allConditions.concat(result.nrqlConditions);
      cursor = result.nextCursor;
    } while (cursor);

    // 3️⃣ Enriquecer condiciones con entity y terms
    const enriched = await enrichConditions(allConditions);

    // 4️⃣ Agregar policyName a cada condición
    const withPolicyName = enriched.map(cond => ({
      ...cond,
      policyName // mismo nombre para todas las condiciones de esta policy
    }));

    res.json(withPolicyName);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener alertas con nombre de policy" });
  }
});

// --- NUEVO APARTADO: ENTIDADES Y SUS ALERTAS ---

async function getAllEntities() {
  let allEntities = [];

  console.log(`Iniciando getAllEntities. ACCOUNT_ID: ${ACCOUNT_ID}`);

  // Lista de criterios de búsqueda para asegurar que traemos todo (APM, Infra, etc.)
  const searchQueries = [
    "domain = 'APM'",          // Todos los servicios APM
    "domain = 'BROWSER'",      // Aplicaciones Browser
    "domain = 'MOBILE'",       // Aplicaciones Mobile
    "domain = 'INFRA' AND type = 'HOST'", // Hosts físicos/virtuales
    "domain = 'SYNTH'",        // Monitores Sintéticos
    "type = 'WORKLOAD'",       // Workloads
    "type = 'DASHBOARD'",      // Dashboards
    "type = 'KEY_TRANSACTION'", // Transacciones clave
    "domain = 'INFRA' AND type = 'VSPHERE_VM'", // VMs de vSphere
    "domain = 'INFRA' AND type = 'VSPHERE_HOST'", // Hosts de vSphere
    "domain = 'INFRA' AND type = 'STORAGE_VOLUME'", // Datastores
    "type = 'FIREWALL'",
    "type = 'ROUTER'",
    "type = 'SWITCH'",
    "type = 'TRAP_DEVICE'"
  ];

  // Consultar cada criterio por separado
  for (const query of searchQueries) {
    let cursor = null;
    let hasMore = true;
    let page = 1;

    while (hasMore) {
      // Si hay cursor, NO enviamos query (así funciona NerdGraph)
      const q = cursor
        ? `{ actor { entitySearch(cursor: "${cursor}") { results { entities { guid name type domain } nextCursor } } } }`
        : `{ actor { entitySearch(query: "${query}") { results { entities { guid name type domain } nextCursor } } } }`;

      try {
        const resp = await graphqlQuery(q);
        if (resp?.errors) {
          console.error(`❌ Error en ${query} [pág ${page}]:`, JSON.stringify(resp.errors));
          break;
        }

        const res = resp?.data?.actor?.entitySearch?.results;
        if (!res) break;

        if (res.entities && res.entities.length > 0) {
          allEntities = allEntities.concat(res.entities);
          console.log(`✓ [${query}] Pág ${page}: ${res.entities.length} entidades.`);
        }

        cursor = res.nextCursor;
        hasMore = !!cursor;
        page++;
        if (page > 10) break; // Límite de seguridad
      } catch (err) {
        console.error(`Error en paginación de ${query}:`, err);
        break;
      }
    }
  }

  console.log(`\n🎯 Proceso getAllEntities finalizado.`);
  console.log(`📊 Total de entidades obtenidas: ${allEntities.length}`);

  // Mostrar resumen por tipo
  const typeCount = {};
  allEntities.forEach(e => {
    // Usar la misma lógica de clasificación que en el endpoint
    let friendlyType = e.type;
    if (e.type === 'APPLICATION' || e.type === 'BROWSER_APPLICATION') {
      if (e.domain === 'APM') friendlyType = 'APM Service';
      else if (e.domain === 'BROWSER') friendlyType = 'Browser Application';
      else if (e.domain === 'MOBILE') friendlyType = 'Mobile Application';
    } else if (e.type === 'MONITOR') {
      friendlyType = 'Synthetic Monitor';
    }
    typeCount[friendlyType] = (typeCount[friendlyType] || 0) + 1;
  });
  console.log("📊 Resumen por tipo:", typeCount);


  return allEntities;
}

app.get("/entities", async (req, res) => {
  try {
    console.log("=== Iniciando endpoint /entities con cruce de alertas ===");

    // 1. Obtener todas las alertas para saber qué entidades están alertadas
    let allConditions = [];
    let alertCursor = null;
    do {
      const q = `{
        actor {
          account(id: ${ACCOUNT_ID}) {
            alerts {
              nrqlConditionsSearch(cursor: ${alertCursor ? `"${alertCursor}"` : null}) {
                nrqlConditions {
                  name
                  entity { guid }
                  nrql { query }
                }
                nextCursor
              }
            }
          }
        }
      }`;
      const data = await graphqlQuery(q);
      const result = data?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
      if (!result) break;
      allConditions = allConditions.concat(result.nrqlConditions);
      alertCursor = result.nextCursor;
    } while (alertCursor);

    // Mapear GUIDs alertados
    const alertedEntitiesMap = {};
    allConditions.forEach(cond => {
      const guids = extractGuidsFromNrql(cond.nrql?.query);
      if (cond.entity?.guid && !guids.includes(cond.entity.guid)) {
        guids.push(cond.entity.guid);
      }

      guids.forEach(guid => {
        if (!alertedEntitiesMap[guid]) alertedEntitiesMap[guid] = [];
        if (!alertedEntitiesMap[guid].includes(cond.name)) {
          alertedEntitiesMap[guid].push(cond.name);
        }
      });
    });

    // 2. Obtener todas las entidades (usando la función que itera tipos)
    const entities = await getAllEntities();

    console.log(`Total de entidades obtenidas: ${entities.length}`);

    // 3. Cruzar datos
    const result = entities.map(ent => {
      // Determinar un nombre de tipo más amigable y descriptivo
      let friendlyType = ent.type;
      if (ent.type === 'APPLICATION' || ent.type === 'BROWSER_APPLICATION') {
        if (ent.domain === 'APM') friendlyType = 'APM Service';
        else if (ent.domain === 'BROWSER') friendlyType = 'Browser Application';
        else if (ent.domain === 'MOBILE') friendlyType = 'Mobile Application';
      } else if (ent.type === 'MONITOR') {
        friendlyType = 'Synthetic Monitor';
      }

      // Buscar alertas por GUID
      let matchedAlerts = alertedEntitiesMap[ent.guid] || [];

      // Fallback: Buscar alertas por nombre en el NRQL o en el nombre de la condición
      // Esto ayuda cuando los GUIDs en las alertas son antiguos o no coinciden exactamente
      if (matchedAlerts.length === 0) {
        const entNameLower = ent.name.toLowerCase();
        allConditions.forEach(cond => {
          const query = (cond.nrql?.query || "").toLowerCase();
          const condName = (cond.name || "").toLowerCase();

          if (query.includes(entNameLower) || condName.includes(entNameLower)) {
            if (!matchedAlerts.includes(cond.name)) {
              matchedAlerts.push(cond.name);
            }
          }
        });
      }

      return {
        name: ent.name,
        type: friendlyType,
        guid: ent.guid,
        hasAlerts: matchedAlerts.length > 0,
        alertNames: matchedAlerts
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Error en endpoint /entities:", err);
    res.status(500).json({ error: "Error al obtener entidades con alertas" });
  }
});


app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
