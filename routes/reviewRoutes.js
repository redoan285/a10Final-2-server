const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/check-eligibility", verifyToken, async (req, res) => {
  try {
    const { ordersCollection } = getCollections();
    const { email, bookId } = req.query;
    if (!email || !bookId) return res.status(400).json({ success: false, canReview: false });
    const order = await ordersCollection.findOne({ "user.email": email, "book.id": new ObjectId(bookId), status: "Delivered" });
    res.status(200).json({ success: true, canReview: !!order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, canReview: false });
  }
});

router.get("/:bookId", async (req, res) => {
  try {
    const { reviewsCollection } = getCollections();
    const reviews = await reviewsCollection.find({ bookId: req.params.bookId }).sort({ createdAt: -1 }).toArray();
    res.status(200).json({ success: true, data: reviews });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, data: [] });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { reviewsCollection, ordersCollection } = getCollections();
    const userEmail = req.user?.email; // never trust a client-supplied email
    const { bookId, rating, comment } = req.body;

    if (!bookId || !rating) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Re-verify eligibility server-side — a client calling check-eligibility
    // first does NOT guarantee this POST is legitimate; it must be checked here too.
    const deliveredOrder = await ordersCollection.findOne({
      "user.email": userEmail,
      "book.id": new ObjectId(bookId),
      status: "Delivered",
    });
    if (!deliveredOrder) {
      return res.status(403).json({ success: false, message: "You can only review books that have been delivered to you" });
    }

    const reviewData = { bookId, rating, comment, userEmail, userName: req.body.userName, createdAt: new Date() };
    const result = await reviewsCollection.insertOne(reviewData);
    res.status(201).json({ success: true, result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to submit review" });
  }
});

router.get("/user/:email", verifyToken, async (req, res) => {
  try {
    const { reviewsCollection, booksCollection, usersCollection } = getCollections();
    const requester = await usersCollection.findOne({ email: req.user?.email });
    if (req.user?.email !== req.params.email && requester?.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only view your own reviews" });
    }
    const reviews = await reviewsCollection.find({ userEmail: req.params.email }).sort({ createdAt: -1 }).toArray();
    const reviewsWithBooks = await Promise.all(
      reviews.map(async (review) => {
        const book = await booksCollection.findOne({ _id: new ObjectId(review.bookId) });
        return { ...review, bookTitle: book ? book.title : "Deleted Book", bookImage: book ? book.coverImage : null };
      })
    );
    res.status(200).json({ success: true, data: reviewsWithBooks });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, data: [] });
  }
});

router.patch("/:id", verifyToken, async (req, res) => {
  try {
    const { reviewsCollection } = getCollections();
    const review = await reviewsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!review) return res.status(404).json({ success: false, message: "Review not found" });
    if (review.userEmail !== req.user?.email) {
      return res.status(403).json({ success: false, message: "You can only edit your own reviews" });
    }
    const { rating, comment } = req.body;
    await reviewsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { rating, comment, updatedAt: new Date() } });
    res.status(200).json({ success: true, message: "Review updated" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error updating review" });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { reviewsCollection, usersCollection } = getCollections();
    const review = await reviewsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!review) return res.status(404).json({ success: false, message: "Review not found" });
    const requester = await usersCollection.findOne({ email: req.user?.email });
    if (review.userEmail !== req.user?.email && requester?.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only delete your own reviews" });
    }
    await reviewsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.status(200).json({ success: true, message: "Review deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error deleting review" });
  }
});

module.exports = router;