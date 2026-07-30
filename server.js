const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'kurir_gresik',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.post('/api/paket', async (req, res) => {
    const { kode_barcode, nama_penerima, lat, lng } = req.body;
    let jam_selesai = req.body.jam_selesai || null;

    try {
        const query = 'INSERT INTO paket (kode_barcode, nama_penerima, latitude, longitude, jam_selesai_tw) VALUES (?, ?, ?, ?, ?)';
        const [result] = await db.execute(query, [kode_barcode, nama_penerima, lat, lng, jam_selesai]);
        res.status(201).json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/paket/bulk', async (req, res) => {
    const paketList = req.body.paketList;
    
    if (!Array.isArray(paketList) || paketList.length === 0) {
        return res.status(400).json({ success: false, message: 'Data paket tidak valid.' });
    }
    
    try {
        const query = 'INSERT INTO paket (kode_barcode, nama_penerima, latitude, longitude, jam_selesai_tw) VALUES ?';
        let values = paketList.map(p => [
            p.kode_barcode, 
            p.nama_penerima, 
            p.lat, 
            p.lng, 
            p.jam_selesai || null
        ]);
        
        await db.query(query, [values]);
        res.status(201).json({ success: true, count: values.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/kendala', async (req, res) => {
    const { nama_lokasi, lat, lng, jenis } = req.body;

    try {
        const query = 'INSERT INTO kendala_jalan (nama_lokasi, latitude, longitude, jenis) VALUES (?, ?, ?, ?)';
        const [result] = await db.execute(query, [nama_lokasi, lat, lng, jenis]);
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function hitungJarakHaversine(lat1, lon1, lat2, lon2) {
    lat1 = parseFloat(lat1);
    lon1 = parseFloat(lon1);
    lat2 = parseFloat(lat2);
    lon2 = parseFloat(lon2);

    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function jarakTitikKeGaris(latP, lonP, latA, lonA, latB, lonB) {
    const x = parseFloat(lonP);
    const y = parseFloat(latP);
    const x1 = parseFloat(lonA);
    const y1 = parseFloat(latA);
    const x2 = parseFloat(lonB);
    const y2 = parseFloat(latB);

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const len_sq = C * C + D * D;
    let param = -1;
    
    if (len_sq !== 0) {
        param = dot / len_sq;
    }

    let xx, yy;
    if (param < 0) {
        xx = x1; 
        yy = y1;
    } else if (param > 1) {
        xx = x2; 
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    return hitungJarakHaversine(y, x, yy, xx);
}

function hitungTitikBelok(latA, lonA, latB, lonB, latKendala, lonKendala) {
    latA = parseFloat(latA);
    lonA = parseFloat(lonA);
    latB = parseFloat(latB);
    lonB = parseFloat(lonB);
    latKendala = parseFloat(latKendala);
    lonKendala = parseFloat(lonKendala);

    const dx = lonB - lonA;
    const dy = latB - latA;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return { lat: latKendala + 0.002, lng: lonKendala + 0.002 };

    const nx = -dy / length;
    const ny = dx / length;
    const offset = 0.002; 

    const belokLng = lonKendala + (nx * offset);
    const belokLat = latKendala + (ny * offset);

    return { lat: belokLat, lng: belokLng };
}

function hitungRuteACO(matrixWaktu, daftarPaket) {
    const n = daftarPaket.length;
    const numAnts = 20; 
    const maxIterations = 50; 
    const alpha = 1.0; 
    const beta = 2.5; 
    const rho = 0.1; 
    const Q = 1000; 

    let pheromone = Array.from({ length: n }, () => Array(n).fill(1.0));
    let ruteTerbaik = [];
    let jarakTerbaik = Infinity;

    for (let iter = 0; iter < maxIterations; iter++) {
        let ruteSemut = [];
        let jarakSemut = [];

        for (let ant = 0; ant < numAnts; ant++) {
            let dikunjungi = Array(n).fill(false);
            let rute = [0]; 
            dikunjungi[0] = true;
            let currentTime = 0;

            for (let step = 1; step < n; step++) {
                let curr = rute[rute.length - 1];
                let probabilitas = [];
                let totalProb = 0;

                for (let next = 0; next < n; next++) {
                    if (!dikunjungi[next]) {
                        let waktu = matrixWaktu[curr][next] || 1;
                        if (waktu < 1) waktu = 1;
                        
                        let penaltyTW = 1.0;
                        if (daftarPaket[next].jam_selesai_tw) {
                            let jamSplit = daftarPaket[next].jam_selesai_tw.split(':');
                            let batasWaktuDetik = (parseInt(jamSplit[0]) * 3600) + (parseInt(jamSplit[1]) * 60);
                            let estimasiTibaDetik = 28800 + currentTime + waktu;
                            
                            penaltyTW = (estimasiTibaDetik > batasWaktuDetik) ? 0.1 : 2.0;
                        }
                        
                        let eta = (1.0 / waktu) * penaltyTW; 
                        let p = Math.pow(pheromone[curr][next], alpha) * Math.pow(eta, beta);
                        
                        probabilitas.push({ node: next, prob: p, waktuTempuh: waktu });
                        totalProb += p;
                    }
                }
                
                let rand = Math.random() * totalProb;
                let cumSum = 0;
                let selectedNode = -1;
                let addedTime = 0;
                
                for (let idxProb = 0; idxProb < probabilitas.length; idxProb++) {
                    let item = probabilitas[idxProb];
                    cumSum += item.prob;
                    if (rand <= cumSum) { 
                        selectedNode = item.node; 
                        addedTime = item.waktuTempuh;
                        break; 
                    }
                }
                
                if (selectedNode === -1 && probabilitas.length > 0) {
                    let lastItem = probabilitas[probabilitas.length - 1];
                    selectedNode = lastItem.node;
                    addedTime = lastItem.waktuTempuh;
                }

                if (selectedNode !== -1) { 
                    dikunjungi[selectedNode] = true; 
                    rute.push(selectedNode); 
                    currentTime += addedTime;
                }
            }

            let totalWaktu = 0;
            for (let i = 0; i < rute.length - 1; i++) {
                totalWaktu += matrixWaktu[rute[i]][rute[i + 1]];
            }
            
            ruteSemut.push(rute); 
            jarakSemut.push(totalWaktu);
            
            if (totalWaktu < jarakTerbaik) { 
                jarakTerbaik = totalWaktu; 
                ruteTerbaik = [...rute];
            }
        }

        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                pheromone[i][j] *= (1 - rho);
            }
        }
        
        for (let k = 0; k < numAnts; k++) {
            let rute = ruteSemut[k];
            let jarakSmut = jarakSemut[k] || 1;
            let kontribusi = Q / jarakSmut; 
            
            for (let i = 0; i < rute.length - 1; i++) {
                pheromone[rute[i]][rute[i + 1]] += kontribusi;
            }
        }
    }
    
    return ruteTerbaik.length === n ? ruteTerbaik : Array.from({ length: n }, (_, i) => i);
}

app.post('/api/optimasi-rute', async (req, res) => {
    try {
        const resiList = req.body.resiList;
        let queryPaket = 'SELECT * FROM paket ORDER BY id ASC';
        let queryParams = [];

        if (resiList && resiList.length > 0) {
            const placeholders = resiList.map(() => '?').join(',');
            queryPaket = `SELECT * FROM paket WHERE kode_barcode IN (${placeholders}) ORDER BY id ASC`;
            queryParams = resiList;
        }

        const [daftarPaketRaw] = await db.query(queryPaket, queryParams);
        
        let daftarPaket = [];
        let cekUnik = new Set();
        for (let p of daftarPaketRaw) {
            if (!cekUnik.has(p.kode_barcode)) {
                cekUnik.add(p.kode_barcode);
                daftarPaket.push(p);
            }
        }

        const [daftarKendala] = await db.query('SELECT * FROM kendala_jalan'); 

        if (daftarPaket.length < 2) {
            return res.status(400).json({ message: 'Minimal butuh 2 titik untuk dihitung rutenya.' });
        }

        const coords = daftarPaket.map(p => `${parseFloat(p.longitude)},${parseFloat(p.latitude)}`).join(';');
        const urlOSRM = `http://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
        const matrixRes = await axios.get(urlOSRM);
        let matrixWaktu = matrixRes.data.durations;

        for (let k of daftarKendala) {
            let penalti = k.jenis === 'ditutup' ? 999999 : 3600;
            
            for (let i = 0; i < daftarPaket.length; i++) {
                for (let j = 0; j < daftarPaket.length; j++) {
                    if (i === j) continue;
                    
                    let pA = daftarPaket[i];
                    let pB = daftarPaket[j];
                    
                    let distKm = jarakTitikKeGaris(
                        parseFloat(k.latitude), parseFloat(k.longitude), 
                        parseFloat(pA.latitude), parseFloat(pA.longitude), 
                        parseFloat(pB.latitude), parseFloat(pB.longitude)
                    );
                    
                    if (distKm < 0.5) { 
                        if (matrixWaktu[i][j] !== null) {
                            matrixWaktu[i][j] += penalti; 
                        }
                    }
                }
            }
        }

        const urutanIndex = hitungRuteACO(matrixWaktu, daftarPaket);
        let paketTergurut = urutanIndex.map(index => daftarPaket[index]);
        let routeCoordsArray = [];
        
        for (let i = 0; i < paketTergurut.length; i++) {
            let pCurrent = paketTergurut[i];
            routeCoordsArray.push(`${parseFloat(pCurrent.longitude)},${parseFloat(pCurrent.latitude)}`);
            
            if (i < paketTergurut.length - 1) {
                let pA = paketTergurut[i];
                let pB = paketTergurut[i+1];
                
                for (let k of daftarKendala) {
                    let distKm = jarakTitikKeGaris(
                        parseFloat(k.latitude), parseFloat(k.longitude), 
                        parseFloat(pA.latitude), parseFloat(pA.longitude), 
                        parseFloat(pB.latitude), parseFloat(pB.longitude)
                    );
                    
                    if (distKm < 0.5) {
                        let titikBelok = hitungTitikBelok(
                            parseFloat(pA.latitude), parseFloat(pA.longitude),
                            parseFloat(pB.latitude), parseFloat(pB.longitude),
                            parseFloat(k.latitude), parseFloat(k.longitude)
                        );
                        routeCoordsArray.push(`${titikBelok.lng},${titikBelok.lat}`);
                    }
                }
            }
        }
        
        const routeCoords = routeCoordsArray.join(';');
        const urlRouteOSRM = `http://router.project-osrm.org/route/v1/driving/${routeCoords}?overview=full&geometries=geojson`;
        const routeRes = await axios.get(urlRouteOSRM);

        res.json({ 
            urutan_paket: paketTergurut, 
            geometry: routeRes.data.routes[0].geometry 
        });
        
    } catch (err) {
        console.error('Gagal optimasi rute:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(5000, () => {
    console.log('Server Backend sudah berjalan di http://localhost:5000');
});