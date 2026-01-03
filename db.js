const mysql = require("mysql2");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "Emo123@Reygriff",
    database: "vaultdb"
});

db.connect(err => {
    if (err) {
        console.error("MySQL connection failed:", err);
        process.exit(1);
    }
    console.log("MySQL connected (db.js)");
});

// Wrap query to handle errors globally
db.safeQuery = (sql, params, callback) => {
    db.query(sql, params, (err, results) => {
        if (err) console.error("DB QUERY ERROR:", err, "SQL:", sql, "Params:", params);
        if (callback) callback(err, results);
    });
};

module.exports = db;
