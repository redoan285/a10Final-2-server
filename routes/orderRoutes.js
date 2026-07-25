const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { verifyToken, verifyAdmin, verifyLibrarian } = require("../middlewares/authMiddleware");
const { Resend } = require("resend");
const Stripe = require("stripe");
const dotenv = require("dotenv");

dotenv.config();
const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.get("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { ordersCollection } = await getCollections();
    const orders = await ordersCollection.aggregate([
      { $sort: { orderedAt: -1 } },
      { $lookup: { from: "books", localField: "book.id", foreignField: "_id", as: "bookDetails" } },
      { $unwind: { path: "$bookDetails", preserveNullAndEmptyArrays: true } },
      { $addFields: { "book.category": { $ifNull: ["$bookDetails.category", "Uncategorized"] } } },
      { $project: { bookDetails: 0 } }
    ]).toArray();
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error fetching orders" });
  }
});

router.get("/librarian/:email", verifyToken, verifyLibrarian, async (req, res) => {
  try {
    const { ordersCollection, usersCollection } = await getCollections();
    const requester = await usersCollection.findOne({ email: req.user?.email });
    if (req.user?.email !== req.params.email && requester?.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only view your own orders" });
    }
    const orders = await ordersCollection.find({ "book.librarianEmail": req.params.email }).sort({ orderedAt: -1 }).toArray();
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error fetching orders" });
  }
});

const ALLOWED_ORDER_STATUSES = ["Pending", "Dispatched", "Delivered"];

router.patch("/:id/status", verifyToken, verifyLibrarian, async (req, res) => {
  try {
    const { ordersCollection, usersCollection } = await getCollections();
    if (!ALLOWED_ORDER_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ success: false, message: "Invalid status value" });
    }

    const order = await ordersCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const requester = await usersCollection.findOne({ email: req.user?.email });
    const isOwner = order.book?.librarianEmail === req.user?.email;
    if (!isOwner && requester?.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only manage deliveries for your own books" });
    }

    await ordersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status } });
    res.status(200).json({ success: true, message: "Order status updated" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Error updating order" });
  }
});

router.get("/check-duplicate", verifyToken, async (req, res) => {
  try {
    const { ordersCollection } = await getCollections();
    const { email, bookId } = req.query;
    if (!email || !bookId) return res.json({ hasOrdered: false });
    const order = await ordersCollection.findOne({ "user.email": email, "book.id": new ObjectId(bookId) });
    res.status(200).json({ success: true, hasOrdered: !!order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, hasOrdered: false });
  }
});

router.get("/user/:email", verifyToken, async (req, res) => {
  try {
    const { ordersCollection, booksCollection, usersCollection } = await getCollections();
    const requester = await usersCollection.findOne({ email: req.user?.email });
    if (req.user?.email !== req.params.email && requester?.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only view your own order history" });
    }
    const orders = await ordersCollection.find({ "user.email": req.params.email }).sort({ orderedAt: -1 }).toArray();
    const ordersWithCategory = await Promise.all(
      orders.map(async (order) => {
        const bookDetails = await booksCollection.findOne({ _id: new ObjectId(order.book.id) });
        return { ...order, book: { ...order.book, category: bookDetails ? bookDetails.category : "Uncategorized" } };
      })
    );
    res.status(200).json({ success: true, data: ordersWithCategory });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const { ordersCollection } = await getCollections();
    const data = req.body;
    if (!data.bookId || !data.sessionId) return res.status(400).json({ success: false, message: "Missing fields" });

    // SECURITY: never trust client-submitted order/payment data. Independently
    // re-verify the Stripe session server-side before recording a "paid" order.
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(data.sessionId);
    } catch (stripeError) {
      console.error(stripeError);
      return res.status(400).json({ success: false, message: "Invalid Stripe session" });
    }

    if (session.payment_status !== "paid") {
      return res.status(402).json({ success: false, message: "Payment not completed" });
    }
    // The session must belong to the logged-in user and the book being ordered —
    // otherwise someone could replay another user's session id.
    if (session.metadata?.userEmail !== req.user?.email || session.metadata?.bookId !== data.bookId) {
      return res.status(403).json({ success: false, message: "Session does not match this request" });
    }
    // Prevent the same paid session from being recorded as more than one order.
    const alreadyRecorded = await ordersCollection.findOne({ stripeSessionId: data.sessionId });
    if (alreadyRecorded) {
      return res.status(200).json({ success: true, message: "Order already recorded", orderId: alreadyRecorded._id });
    }

    const meta = session.metadata;
    const newOrder = {
      user: { id: meta.userId, name: meta.userName, email: meta.userEmail, role: meta.userRole },
      book: { id: new ObjectId(meta.bookId), title: meta.bookTitle, coverImage: meta.coverImage, deliveryFee: parseFloat(meta.deliveryFee), author: meta.author, librarianEmail: meta.librarianEmail },
      stripeSessionId: session.id,
      paymentGateway: "Stripe",
      status: "Pending Delivery",
      orderedAt: new Date(),
    };

    const orderResult = await ordersCollection.insertOne(newOrder);

    if (orderResult.insertedId) {
      try {
        await resend.emails.send({
          from: "BiblioDrop <onboarding@resend.dev>",
          to: meta.userEmail,
          subject: `Order Confirmed! Invoice #${orderResult.insertedId}`,
          html: `<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px 20px;">
            <div style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #f4f4f5;">
              <div style="background-color: #10b981; padding: 35px 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px; font-weight: bold;">BiblioDrop</h1>
                <p style="color: #d1fae5; margin: 8px 0 0 0; font-size: 15px; letter-spacing: 0.5px;">Payment Receipt</p>
              </div>
              <div style="padding: 40px 30px;">
                <div style="margin-bottom: 30px;">
                  <p style="margin: 0 0 5px 0; color: #a1a1aa; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Receipt Number</p>
                  <p style="margin: 0; font-size: 16px; color: #18181b; font-weight: 600;">#${orderResult.insertedId}</p>
                </div>
                <table style="width: 100%; margin-bottom: 40px; border-collapse: collapse;">
                  <tr>
                    <td style="padding-bottom: 10px;">
                      <p style="margin: 0 0 5px 0; color: #a1a1aa; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Date Paid</p>
                      <p style="margin: 0; font-size: 15px; color: #18181b; font-weight: 500;">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                    </td>
                    <td style="padding-bottom: 10px; text-align: right;">
                      <p style="margin: 0 0 5px 0; color: #a1a1aa; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Payment Method</p>
                      <p style="margin: 0; font-size: 15px; color: #18181b; font-weight: 500;">Card (Stripe)</p>
                    </td>
                  </tr>
                </table>
                <h3 style="color: #18181b; font-size: 16px; margin: 0 0 15px 0; border-bottom: 1px solid #e4e4e7; padding-bottom: 10px;">Order Summary</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tr>
                    <td style="padding: 15px 0; width: 60px; vertical-align: top;">
                      <img src="${meta.coverImage}" alt="${meta.bookTitle}" width="50" height="75" style="display: block; width: 50px; height: 75px; object-fit: cover; border-radius: 6px; border: 1px solid #e4e4e7;" />
                    </td>
                    <td style="padding: 15px 15px; vertical-align: top;">
                      <p style="margin: 0; font-weight: 600; color: #18181b; font-size: 16px;">${meta.bookTitle}</p>
                      <p style="margin: 4px 0 0 0; font-size: 14px; color: #71717a;">by ${meta.author}</p>
                    </td>
                    <td style="padding: 15px 0; vertical-align: top; text-align: right;">
                      <p style="margin: 0; font-weight: 600; color: #18181b; font-size: 16px;">$${parseFloat(meta.deliveryFee).toFixed(2)}</p>
                    </td>
                  </tr>
                </table>
                <div style="border-top: 1px dashed #d4d4d8; padding-top: 25px; text-align: right;">
                  <p style="margin: 0 0 10px 0; color: #71717a; font-size: 15px;">Subtotal: &nbsp;&nbsp; <span style="color: #18181b; font-weight: 500;">$${parseFloat(meta.deliveryFee).toFixed(2)}</span></p>
                  <p style="margin: 0; font-size: 22px; font-weight: bold; color: #10b981;">Total Paid: &nbsp;&nbsp; $${parseFloat(meta.deliveryFee).toFixed(2)}</p>
                </div>
              </div>
              <div style="background-color: #f4f4f5; padding: 20px 30px; text-align: center; border-top: 1px solid #e4e4e7;">
                <p style="margin: 0; color: #71717a; font-size: 13px;">Billed to <span style="font-weight: 600; color: #18181b;">${meta.userName}</span> (<a href="mailto:${meta.userEmail}" style="color: #10b981; text-decoration: none;">${meta.userEmail}</a>)</p>
                <p style="margin: 8px 0 0 0; color: #a1a1aa; font-size: 12px;">© ${new Date().getFullYear()} BiblioDrop. All rights reserved.</p>
              </div>
            </div>
          </div>`,
        });
      } catch (emailError) {
        console.error("Resend Email Error:", emailError);
      }
    }
    res.status(201).json({ success: true, orderId: orderResult.insertedId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;