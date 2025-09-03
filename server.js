import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

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

// -------------------- FUNCIONES AUXILIARES --------------------

// Función para consultar la API GraphQL de New Relic
async function graphqlQuery(query) {
  const response = await fetch("https://api.newrelic.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "API-Key": NEW_RELIC_API_KEY,
    },
    body: JSON.stringify({ query }),
  });
  return response.json();
}

// Función para obtener el nombre y tipo real de una entidad por su GUID
async function getEntityByGuid(guid) {
  if (!guid) return { name: null, type: null, guid: null };
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
    return {
      guid,
      name: data?.data?.actor?.entity?.name || null,
      type: data?.data?.actor?.entity?.type || null,
    };
  } catch (err) {
    console.error("❌ Error al obtener entidad:", err);
    return { name: null, type: null, guid };
  }
}

// Función para extraer GUID desde el NRQL query
function extractGuidFromNrql(nrqlQuery) {
  if (!nrqlQuery) return null;
  const regex = /entity\.?guid\s*(?:IN\s*\(|=)\s*['"]([^'"]+)['"]/i;
  const match = nrqlQuery.match(regex);
  return match ? match[1] : null;
}

// Función para procesar y agregar realEntity a las alertas
async function enrichAlertsWithEntity(nrqlConditions) {
  const enriched = [];
  for (const condition of nrqlConditions) {
    let guid = extractGuidFromNrql(condition.nrql?.query) || condition.entity?.guid;
    const realEntity = await getEntityByGuid(guid);
    condition.realEntity = realEntity;
    enriched.push(condition);
  }
  return enriched;
}

// -------------------- ENDPOINTS --------------------

// Traer todas las alertas con realEntity
app.get("/alerts-all", async (req, res) => {
  let allConditions = [];
  let cursor = null;

  try {
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
                totalCount
              }
            }
          }
        }
      }`;

      const data = await graphqlQuery(query);
      const result = data?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
      if (!result) break;

      const enriched = await enrichAlertsWithEntity(result.nrqlConditions);
      allConditions = allConditions.concat(enriched);
      cursor = result.nextCursor;

    } while (cursor);

    res.json(allConditions);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener todas las alertas" });
  }
});

// Traer alertas filtradas por policyId con realEntity
app.post("/alerts", async (req, res) => {
  const { policyId } = req.body;
  if (!policyId) return res.status(400).json({ error: "policyId es requerido" });

  let allConditions = [];
  let cursor = null;

  try {
    do {
      const query = `{
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

      const enriched = await enrichAlertsWithEntity(result.nrqlConditions);
      allConditions = allConditions.concat(enriched);
      cursor = result.nextCursor;

    } while (cursor);

    res.json(allConditions);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener alertas" });
  }
});

// -------------------- INICIO DEL SERVIDOR --------------------
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log("🔍 Consultando todas las alertas al iniciar...");

  const initialAlerts = await graphqlQuery(`{
    actor {
      account(id: ${ACCOUNT_ID}) {
        alerts {
          nrqlConditionsSearch(cursor: null) {
            nrqlConditions {
              id
              name
              description
              enabled
              type
              runbookUrl
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
  }`);

  console.log("✅ Consulta inicial completada.");
});
