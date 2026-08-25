require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de CORS y parseo de JSON
app.use(cors());
app.use(express.json());

// Cliente de Supabase (usando la llave de servicio para poder hacer bypass al RLS desde el backend)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // <-- CAMBIAR AQUÍ
);

// Middleware para verificar el Token JWT enviado desde el frontend de React
const verificarAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Falta el token de autorización' });
    }

    const token = authHeader.split(' ')[1];

    // Supabase verifica si el token es válido y no ha expirado
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    // Guardamos los datos del usuario en la request para usarlo en las rutas
    req.user = user;
    next();
};

// ==========================================
// RUTAS CRUD DE GASTOS
// ==========================================

// 1. LEER (GET) - Obtener todos los gastos del usuario autenticado
app.get('/api/gastos', verificarAuth, async (req, res) => {
    const { data, error } = await supabase
        .from('gastos')
        .select('*')
        .eq('user_id', req.user.id)
        .order('fecha', { ascending: false }); // Ordenar por fecha más reciente

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. CREAR (POST) - Registrar un nuevo gasto
app.post('/api/gastos', verificarAuth, async (req, res) => {
    const { fecha, categoria, monto, descripcion } = req.body;

    const { data, error } = await supabase
        .from('gastos')
        .insert([
            {
                user_id: req.user.id, // Asignamos el gasto al usuario logueado
                fecha,
                categoria,
                monto,
                descripcion
            }
        ])
        .select(); // Devolvemos el registro recién creado

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 3. ACTUALIZAR (PUT) - Modificar un gasto existente
app.put('/api/gastos/:id', verificarAuth, async (req, res) => {
    const { id } = req.params;
    const { fecha, categoria, monto, descripcion } = req.body;

    const { data, error } = await supabase
        .from('gastos')
        .update({ fecha, categoria, monto, descripcion })
        .eq('id', id)
        .eq('user_id', req.user.id) // Capa de seguridad: asegurar que sea su propio gasto
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// 4. ELIMINAR (DELETE) - Borrar un gasto
app.delete('/api/gastos/:id', verificarAuth, async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase
        .from('gastos')
        .delete()
        .eq('id', id)
        .eq('user_id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Gasto eliminado correctamente' });
});

// Levantar el servidor
app.listen(port, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});

// Inicializar Gemini con la API Key del .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Endpoint de Chat Financiero Inteligente
app.post('/api/chat', verificarAuth, async (req, res) => {
    const { pregunta, filtroAnio, filtroMes, historial } = req.body;

    try {
        // 1. Obtener perfil y gastos
        const { data: perfil } = await supabase
            .from('perfiles')
            .select('salarios_mensuales')
            .eq('id', req.user.id)
            .single();

        const { data: gastosBrutos, error } = await supabase
            .from('gastos')
            .select('fecha, categoria, monto, descripcion')
            .eq('user_id', req.user.id);

        if (error) throw error;

        // 2. Filtrar gastos y calcular salario
        const listaGastos = gastosBrutos || [];
        const gastosFiltrados = listaGastos.filter(g => {
            if (!g.fecha) return false;
            const [year, month] = g.fecha.split('-');
            const coincideAnio = !filtroAnio || year === filtroAnio;
            const coincideMes = !filtroMes || month === filtroMes;
            return coincideAnio && coincideMes;
        });

        let salarioActivo = 0;
        if (perfil && perfil.salarios_mensuales) {
            if (filtroMes) salarioActivo = Number(perfil.salarios_mensuales[filtroMes]) || 0;
            else salarioActivo = Object.values(perfil.salarios_mensuales).reduce((acc, val) => acc + Number(val), 0);
        }

        let periodoTexto = "Histórico completo";
        if (filtroAnio && filtroMes) periodoTexto = `Mes ${filtroMes} del Año ${filtroAnio}`;
        else if (filtroAnio) periodoTexto = `Todo el Año ${filtroAnio}`;
        else if (filtroMes) periodoTexto = `Mes ${filtroMes} de todos los años registrados`;

        // 3. Formatear el historial para la API de Gemini
        const historialGemini = (historial || [])
            // Omitimos el mensaje de saludo inicial para no confundir a la IA
            .filter(msg => msg.texto && !msg.texto.includes('¡Hola! Soy tu asistente financiero.'))
            .map(msg => ({
                role: msg.rol === 'ia' ? 'model' : 'user',
                parts: [{ text: msg.texto }]
            }));

        // 4. Crear el super-prompt unificado (Contexto + Pregunta actual)
        const contextoFinanciero = {
            periodo_analizado: periodoTexto,
            salario_neto_del_periodo: salarioActivo,
            gastos: gastosFiltrados
        };

        const promptUnificado = `
[CONTEXTO FINANCIERO DEL USUARIO ACTUALIZADO]
Datos actuales filtrados por el usuario (${periodoTexto}):
${JSON.stringify(contextoFinanciero)}

INSTRUCCIONES:
- Responde a la pregunta actual del usuario manteniendo el hilo de la conversación anterior.
- Basa tus cálculos ÚNICAMENTE en el JSON de contexto financiero provisto arriba.
- Sé preciso, amable, directo y sin rodeos.

PREGUNTA ACTUAL DEL USUARIO:
"${pregunta}"
`;

        // 5. Iniciar Chat con Memoria en Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const chat = model.startChat({ history: historialGemini });

        const result = await chat.sendMessage(promptUnificado);
        const respuesta = await result.response.text();

        res.json({ respuesta });
    } catch (err) {
        console.error('Error detallado en /api/chat:', err);
        res.status(500).json({ error: 'Fallo interno en el servidor.' });
    }
});

// ==========================================
// RUTAS DE PERFIL / CONFIGURACIÓN
// ==========================================

// OBTENER PERFIL
app.get('/api/perfil', verificarAuth, async (req, res) => {
    let { data, error } = await supabase
        .from('perfiles')
        .select('*')
        .eq('id', req.user.id)
        .single();

    if (!data && error?.code === 'PGRST116') {
        const defaultSalarios = { "01": 0, "02": 0, "03": 0, "04": 0, "05": 0, "06": 0, "07": 0, "08": 0, "09": 0, "10": 0, "11": 0, "12": 0 };
        const { data: newPerfil, error: insertError } = await supabase
            .from('perfiles')
            .insert([{ id: req.user.id, salario_neto: 0, salarios_mensuales: defaultSalarios }])
            .select()
            .single();

        if (insertError) return res.status(500).json({ error: insertError.message });
        return res.json(newPerfil);
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ACTUALIZAR SALARIOS MENSUALES
app.put('/api/perfil', verificarAuth, async (req, res) => {
    const { salarios_mensuales, salario_neto } = req.body;

    const { data, error } = await supabase
        .from('perfiles')
        .update({ salarios_mensuales, salario_neto })
        .eq('id', req.user.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ACTUALIZAR SALARIO
app.put('/api/perfil', verificarAuth, async (req, res) => {
    const { salario_neto } = req.body;

    const { data, error } = await supabase
        .from('perfiles')
        .update({ salario_neto })
        .eq('id', req.user.id) // <-- Usando 'id'
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});