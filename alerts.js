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
        console.error("❌ Error al obtener entidad:", err);
        return { name: null, type: null };
    }
}

// Función para extraer GUID desde el NRQL query
function extractGuidFromNrql(nrqlQuery) {
    if (!nrqlQuery) return null;
    const regex = /entity\.?guid\s*(?:IN\s*\(|=)\s*['"]([^'"]+)['"]/i;
    const match = nrqlQuery.match(regex);
    return match ? match[1] : null;
}

// Función para traer todas las alertas NRQL y agregar info de la entidad
async function getAllAlerts() {
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

            for (const condition of result.nrqlConditions) {
                // 🔹 Extraer GUID real desde NRQL query o usar entity.guid
                let guid = extractGuidFromNrql(condition.nrql?.query) || condition.entity?.guid;

                // 🔹 Consultar la entidad real solo si tenemos GUID
                let realEntity = { name: null, type: null, guid: guid || null };
                if (guid) {
                    const entityData = await getEntityByGuid(guid);
                    realEntity = {
                        guid,
                        name: entityData?.name || condition.entity?.name || null,
                        type: entityData?.type || condition.entity?.type || null
                    };
                }

                // 🔹 Agregar info real de la entidad a la alerta
                condition.realEntity = realEntity;

                // 🔹 Imprimir toda la alerta en consola
                console.log("🔔 Alerta completa con entidad asociada:");
                console.dir(condition, { depth: null });
                console.log("--------------------------------------------------");
            }

            allConditions = allConditions.concat(result.nrqlConditions);
            cursor = result.nextCursor;
        } while (cursor);

        return allConditions;
    } catch (err) {
        console.error("❌ Error al obtener alertas:", err);
        return [];
    }
}

// Endpoint para devolver todas las alertas en JSON
app.get("/alerts-all", async (req, res) => {
    const alerts = await getAllAlerts();
    res.json(alerts);
});

// Al iniciar el servidor, traer alertas automáticamente
app.listen(PORT, async () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log("🔍 Consultando todas las alertas...");

    const alerts = await getAllAlerts();
    console.log("✅ Todas las alertas han sido obtenidas.");
});
