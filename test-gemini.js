require('dotenv').config();

async function probarGemini() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return console.log("❌ No se encontró la variable GEMINI_API_KEY en el .env");
    }

    console.log("📡 Consultando directamente a los servidores de Google...");

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    try {
        const respuesta = await fetch(url);
        const datos = await respuesta.json();

        if (datos.error) {
            console.error("\n❌ LA API RECHAZÓ LA LLAVE:");
            console.error(datos.error.message);
        } else {
            console.log("\n✅ CONEXIÓN EXITOSA. Estos son los modelos que TU llave tiene permitidos:");

            // Filtramos solo los que sirven para chat/texto (generateContent)
            const modelosSoportados = datos.models.filter(m =>
                m.supportedGenerationMethods.includes('generateContent')
            );

            modelosSoportados.forEach(m => {
                const nombreLimpio = m.name.replace('models/', '');
                console.log(`👉 "${nombreLimpio}"`);
            });
        }
    } catch (e) {
        console.log("Error fatal de red:", e);
    }
}

probarGemini();