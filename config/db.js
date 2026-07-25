const { MongoClient, ServerApiVersion } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database;

async function connectDB() {
  if (!database) {
    await client.connect(); // ← was incorrectly commented out
    database = client.db(process.env.DB_NAME);
    console.log("BiblioDrop MongoDB Connected Successfully");
  }
  return database;
}

// Async version — always awaits connection (safe for Vercel cold starts)
async function getCollections() {
  await connectDB();
  return {
    usersCollection: database.collection("user"),
    booksCollection: database.collection("books"),
    ordersCollection: database.collection("orders"),
    reviewsCollection: database.collection("reviews"),
    wishlistCollection: database.collection("wishlist"),
  };
}

module.exports = { connectDB, getCollections };