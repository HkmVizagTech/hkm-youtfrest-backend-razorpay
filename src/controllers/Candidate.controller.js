const Candidate = require('../models/Candidate.model');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const sendWhatsappGupshup = require('../utils/sendWhatsappGupshup');
const { 
 sendCertificateWithCloudinary, generateDocumentId, generateCertificatePDF, testCloudinaryConnection, testWhatsAppConnection
} = require('../utils/sendCertificateWithTemplate');
const path = require('path');
const fs = require('fs');
require('dotenv').config();



const tempDir = path.join(__dirname, '../temp/certificates');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });


const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const CandidateController = {

  createCandidate: async (req, res) => {
    try {
      const candidateData = {
        ...req.body,
        registrationDate: new Date(),
        lastUpdated: new Date()
      };
      
      const candidate = new Candidate(candidateData);
      await candidate.save();
      
      console.log(` New candidate created: ${candidate.name} (${candidate.email})`);
      
      res.status(201).json({
        status: 'success',
        message: 'Candidate created successfully',
        candidate
      });
    } catch (error) {
      console.error(' Error creating candidate:', error);
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },

  // Get all candidates
  getAllCandidates: async (req, res) => {
    try {
      const { page = 1, limit = 50, status, paymentStatus } = req.query;
      
      let query = {};
      if (status) query.status = status;
      if (paymentStatus) query.paymentStatus = paymentStatus;

      const candidates = await Candidate.find(query)
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .sort({ registrationDate: -1 });

      const total = await Candidate.countDocuments(query);

      res.json({
        status: 'success',
        candidates,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalCandidates: total,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      });
    } catch (error) {
      console.error('Error fetching candidates:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },

  // Get candidate by ID
  getCandidateById: async (req, res) => {
    try {
      const candidate = await Candidate.findById(req.params.id);
      
      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      res.json({
        status: 'success',
        candidate
      });
    } catch (error) {
      console.error(' Error fetching candidate:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  updateCandidate: async (req, res) => {
    try {
      const updates = {
        ...req.body,
        lastUpdated: new Date(),
        updatedBy: 'saikiran11461'
      };

      const candidate = await Candidate.findByIdAndUpdate(
        req.params.id,
        updates,
        { new: true, runValidators: true }
      );

      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      console.log(` Candidate updated: ${candidate.name} by saikiran11461`);

      res.json({
        status: 'success',
        message: 'Candidate updated successfully',
        candidate
      });
    } catch (error) {
      console.error(' Error updating candidate:', error);
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
  },


  deleteCandidate: async (req, res) => {
    try {
      const candidate = await Candidate.findByIdAndDelete(req.params.id);

      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      console.log(` Candidate deleted: ${candidate.name} by saikiran11461`);

      res.json({
        status: 'success',
        message: 'Candidate deleted successfully'
      });
    } catch (error) {
      console.error(' Error deleting candidate:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  deleteByName: async (req, res) => {
    try {
      const { name } = req.body;
      
      if (!name) {
        return res.status(400).json({
          status: 'error',
          message: 'Name is required'
        });
      }

      const result = await Candidate.deleteMany({ 
        name: { $regex: new RegExp(name, 'i') } 
      });

      console.log(` Deleted ${result.deletedCount} candidates with name: ${name} by saikiran11461`);

      res.json({
        status: 'success',
        message: `Deleted ${result.deletedCount} candidates`,
        deletedCount: result.deletedCount
      });
    } catch (error) {
      console.error(' Error deleting candidates by name:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  createOrder: async (req, res) => {
    try {
      const { amount, candidateId } = req.body;

      const candidate = await Candidate.findById(candidateId);
      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      const options = {
        amount: amount * 100, 
        currency: 'INR',
        receipt: `receipt_${candidateId}_${Date.now()}`,
        notes: {
          candidateId: candidateId,
          candidateName: candidate.name,
          candidateEmail: candidate.email
        }
      };

      const order = await razorpay.orders.create(options);

  
      await Candidate.findByIdAndUpdate(candidateId, {
        razorpayOrderId: order.id,
        orderAmount: amount,
        orderDate: new Date(),
        paymentStatus: 'Pending'
      });

      console.log(`💳 Order created for ${candidate.name}: ${order.id}`);

      res.json({
        status: 'success',
        order,
        key: process.env.RAZORPAY_KEY_ID
      });
    } catch (error) {
      console.error(' Error creating order:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  verifyPayment: async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest("hex");

      if (expectedSignature === razorpay_signature) {

        const candidate = await Candidate.findOneAndUpdate(
          { razorpayOrderId: razorpay_order_id },
          {
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            paymentStatus: 'Paid',
            paymentDate: new Date(),
            verifiedBy: 'saikiran11461'
          },
          { new: true }
        );

        if (!candidate) {
          return res.status(404).json({
            status: 'error',
            message: 'Candidate not found for this order'
          });
        }

        console.log(` Payment verified for ${candidate.name}: ${razorpay_payment_id}`);


        try {
          await sendWhatsappGupshup(candidate);
          console.log(` WhatsApp sent to ${candidate.name}`);
        } catch (whatsappError) {
          console.error(' WhatsApp sending failed:', whatsappError);
        }

        res.json({
          status: 'success',
          message: 'Payment verified successfully',
          candidate
        });
      } else {
        res.status(400).json({
          status: 'error',
          message: 'Payment verification failed'
        });
      }
    } catch (error) {
      console.error(' Error verifying payment:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  verifyPaymentId: async (req, res) => {
    try {
      const candidate = await Candidate.findById(req.params.id);
      
      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      res.json({
        status: 'success',
        candidate: {
          name: candidate.name,
          email: candidate.email,
          paymentStatus: candidate.paymentStatus,
          razorpayOrderId: candidate.razorpayOrderId,
          razorpayPaymentId: candidate.razorpayPaymentId,
          paymentDate: candidate.paymentDate
        }
      });
    } catch (error) {
      console.error('Error fetching payment verification:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  webhook: async (req, res) => {
    try {
      const webhookSignature = req.headers['x-razorpay-signature'];
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

      if (webhookSecret) {
        const expectedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(JSON.stringify(req.body))
          .digest('hex');

        if (expectedSignature !== webhookSignature) {
          return res.status(400).json({
            status: 'error',
            message: 'Webhook signature verification failed'
          });
        }
      }

      const event = req.body.event;
      const paymentEntity = req.body.payload.payment.entity;

      console.log(` Webhook received: ${event}`);

      if (event === 'payment.captured') {
        const candidate = await Candidate.findOneAndUpdate(
          { razorpayOrderId: paymentEntity.order_id },
          {
            paymentStatus: 'Paid',
            paymentDate: new Date(),
            webhookProcessed: true,
            webhookProcessedAt: new Date(),
            processedBy: 'webhook_saikiran11461'
          },
          { new: true }
        );

        if (candidate) {
          console.log(` Webhook processed for ${candidate.name}`);
        }
      }

      res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error(' Webhook error:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },

  markAttendance: async (req, res) => {
    try {
      const { candidateId } = req.body;

      const candidate = await Candidate.findByIdAndUpdate(
        candidateId,
        {
          attendance: true,
          attendanceDate: new Date(),
          attendanceMarkedBy: 'saikiran11461'
        },
        { new: true }
      );

      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      console.log(` Attendance marked for ${candidate.name} by saikiran11461`);

      res.json({
        status: 'success',
        message: 'Attendance marked successfully',
        candidate
      });
    } catch (error) {
      console.error(' Error marking attendance:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  adminAttendanceScan: async (req, res) => {
    try {
      const { qrData } = req.body;

    
      let candidateId;
      try {
        const qrJson = JSON.parse(qrData);
        candidateId = qrJson.candidateId || qrJson.id;
      } catch {
        candidateId = qrData; 
      }

      const candidate = await Candidate.findByIdAndUpdate(
        candidateId,
        {
          attendance: true,
          attendanceDate: new Date(),
          attendanceMarkedBy: 'admin_scan_saikiran11461',
          qrScanned: true,
          qrScannedAt: new Date()
        },
        { new: true }
      );

      if (!candidate) {
        return res.status(404).json({
          status: 'error',
          message: 'Candidate not found'
        });
      }

      console.log(` QR scanned attendance for ${candidate.name} by saikiran11461`);

      res.json({
        status: 'success',
        message: 'Attendance marked via QR scan',
        candidate
      });
    } catch (error) {
      console.error(' Error in admin attendance scan:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },


  attendanceList: async (req, res) => {
    try {
      const { date, status } = req.query;
      
      let query = {};
      if (status === 'present') query.attendance = true;
      if (status === 'absent') query.attendance = { $ne: true };
      
      if (date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        
        query.attendanceDate = { $gte: startOfDay, $lte: endOfDay };
      }

      const candidates = await Candidate.find(query)
        .select('name email whatsappNumber college course attendance attendanceDate')
        .sort({ attendanceDate: -1 });

      const summary = {
        total: candidates.length,
        present: candidates.filter(c => c.attendance).length,
        absent: candidates.filter(c => !c.attendance).length
      };

      res.json({
        status: 'success',
        summary,
        candidates
      });
    } catch (error) {
      console.error('Error fetching attendance list:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },

  
  adminScannedList: async (req, res) => {
    try {
      const candidates = await Candidate.find({ qrScanned: true })
        .select('name email whatsappNumber college course attendanceDate qrScannedAt')
        .sort({ qrScannedAt: -1 });

      res.json({
        status: 'success',
        total: candidates.length,
        candidates
      });
    } catch (error) {
      console.error(' Error fetching admin scanned list:', error);
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  },



   getEligibleCandidatesForCertificate: async (req, res) => {
    try {
      const eligibleCandidates = await Candidate.find(
        { attendance: true, paymentStatus: "Paid" },
        {
          _id: 1, name: 1, email: 1, whatsappNumber: 1, college: 1, course: 1, gender: 1,
          attendanceDate: 1, certificateSent: 1, certificateSentDate: 1, certificateSentBy: 1,
          certificateDocumentId: 1, certificateCloudinaryUrl: 1, certificateCloudinaryPublicId: 1,
          certificateCloudinaryAssetId: 1, certificateFileName: 1, certificateFileSize: 1,
          certificateStorageMethod: 1, certificateWhatsAppMessageId: 1, certificateWhatsAppStatus: 1,
          certificateDeliveryMethod: 1
        }
      ).sort({ attendanceDate: -1 });

      const summary = {
        total: eligibleCandidates.length,
        certificatesSent: eligibleCandidates.filter(c => c.certificateSent).length,
        pendingCertificates: eligibleCandidates.filter(c => !c.certificateSent).length,
        withCloudinaryFiles: eligibleCandidates.filter(c => c.certificateCloudinaryUrl).length
      };

      console.log(` Certificate eligibility check by saikiran11461 at 2025-08-24 18:19:32 UTC - Found ${eligibleCandidates.length} eligible candidates`);

      return res.json({
        status: "success",
        summary,
        candidates: eligibleCandidates,
        storageMethod: "cloudinary",
        cloudName: "ddmzeqpkc",
        fetchedAt: new Date().toISOString(),
        fetchedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Error fetching eligible candidates by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: error.message,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  sendCertificates: async (req, res) => {
    try {
      console.log(` Bulk certificate sending initiated by saikiran11461 at 2025-08-24 18:19:32 UTC`);
      
      const { candidateIds } = req.body;
      let query = { attendance: true, paymentStatus: "Paid" };
      if (candidateIds && candidateIds.length > 0) query._id = { $in: candidateIds };

      const candidates = await Candidate.find(query);
      if (candidates.length === 0) {
        return res.status(404).json({ 
          status: "error", 
          message: "No eligible candidates found", 
          timestamp: new Date().toISOString(),
          requestedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

      let successCount = 0, failureCount = 0, alreadySentCount = 0, results = [];

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        
        console.log(`📝 Processing certificate ${i + 1}/${candidates.length} for ${candidate.name} by saikiran11461`);
        
        if (candidate.certificateSent) {
          alreadySentCount++;
          results.push({ 
            candidateId: candidate._id, 
            name: candidate.name, 
            whatsappNumber: candidate.whatsappNumber, 
            status: 'already-sent', 
            sentDate: candidate.certificateSentDate,
            documentId: candidate.certificateDocumentId,
            cloudinaryUrl: candidate.certificateCloudinaryUrl,
            cloudinaryPublicId: candidate.certificateCloudinaryPublicId,
            processedAt: new Date().toISOString(),
            storageMethod: "cloudinary"
          });
          continue;
        }

        try {
   
          console.log(`☁️ Using Cloudinary certificate system for ${candidate.name} by saikiran11461`);
          const certificatePath = tempDir;
          const result = await sendCertificateWithCloudinary(candidate, certificatePath);
          
          if (!result.success) {
            throw new Error(result.error);
          }

        
          await Candidate.findByIdAndUpdate(candidate._id, {
            certificateSent: true,
            certificateSentDate: new Date(),
            certificateSentBy: 'saikiran11461',
            certificateDocumentId: result.documentId,
            certificateCloudinaryUrl: result.cloudinary.url,
            certificateCloudinaryPublicId: result.cloudinary.publicId,
            certificateCloudinaryAssetId: result.cloudinary.assetId,
            certificateFileName: `${result.documentId}.pdf`,
            certificateFileSize: result.cloudinary.size,
            certificateStorageMethod: 'cloudinary',
            certificateWhatsAppMessageId: result.messageId,
            certificateWhatsAppStatus: result.status,
            certificateDeliveryMethod: result.method,
            updatedAt: new Date(),
            updatedBy: 'saikiran11461'
          });

          successCount++;
          console.log(` Certificate sent successfully to ${candidate.name} - Document ID: ${result.documentId}`);
          
          results.push({
            candidateId: candidate._id, 
            name: candidate.name, 
            whatsappNumber: candidate.whatsappNumber,
            status: 'success', 
            sentAt: new Date().toISOString(),
            documentId: result.documentId,
            cloudinaryUrl: result.cloudinary.url,
            cloudinaryPublicId: result.cloudinary.publicId,
            cloudinaryAssetId: result.cloudinary.assetId,
            fileSize: result.cloudinary.size,
            whatsappMessageId: result.messageId,
            whatsappStatus: result.status,
            deliveryMethod: result.method,
            storageMethod: 'cloudinary',
            processedBy: 'saikiran11461'
          });
          
        } catch (error) {
          failureCount++;
          console.error(` Failed to send certificate to ${candidate.name} by saikiran11461:`, error.message);
          
          results.push({
            candidateId: candidate._id, 
            name: candidate.name, 
            whatsappNumber: candidate.whatsappNumber,
            status: 'failed', 
            error: error.message, 
            failedAt: new Date().toISOString(),
            processedBy: 'saikiran11461'
          });
        }


        if (i < candidates.length - 1) {
          console.log(`⏳ Waiting 3 seconds before next certificate by saikiran11461...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      const summary = {
        total: candidates.length,
        successful: successCount,
        failed: failureCount,
        alreadySent: alreadySentCount,
        successRate: candidates.length > 0 ? ((successCount / candidates.length) * 100).toFixed(2) + '%' : '0%'
      };

      console.log(`📊 Bulk certificate processing completed by saikiran11461 at 2025-08-24 18:19:32 UTC - Success: ${successCount}, Failed: ${failureCount}, Already sent: ${alreadySentCount}`);

      return res.json({
        status: "completed",
        message: `Certificate processing completed. Success: ${successCount}, Failed: ${failureCount}, Already sent: ${alreadySentCount}`,
        summary,
        results,
        storageMethod: "cloudinary",
        cloudName: "ddmzeqpkc",
        processedAt: new Date().toISOString(),
        processedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Error in bulk certificate sending by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: error.message,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  sendSingleCertificate: async (req, res) => {
    try {
      const { candidateId } = req.body;
      
      console.log(` Single certificate sending initiated by saikiran11461 at 2025-08-24 18:19:32 UTC for candidate ID: ${candidateId}`);
      
      const candidate = await Candidate.findById(candidateId);

      if (!candidate) {
        return res.status(404).json({ 
          status: "error", 
          message: "Candidate not found", 
          candidateId: candidateId,
          timestamp: new Date().toISOString(),
          requestedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }
      
      if (!candidate.attendance || candidate.paymentStatus !== "Paid") {
        console.log(` Candidate ${candidate.name} not eligible - attendance: ${candidate.attendance}, payment: ${candidate.paymentStatus}`);
        return res.status(400).json({
          status: "error",
          message: `Candidate not eligible: attendance=${candidate.attendance}, payment=${candidate.paymentStatus}`,
          candidate: { 
            id: candidate._id,
            name: candidate.name, 
            attendance: candidate.attendance, 
            paymentStatus: candidate.paymentStatus 
          },
          timestamp: new Date().toISOString(),
          checkedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }
      
      if (candidate.certificateSent) {
        console.log(`ℹ️ Certificate already sent to ${candidate.name} - Document ID: ${candidate.certificateDocumentId}`);
        return res.status(200).json({
          status: "already-sent",
          message: `Certificate already sent to ${candidate.name} on ${candidate.certificateSentDate?.toLocaleDateString()}`,
          candidate: { 
            id: candidate._id,
            name: candidate.name, 
            whatsappNumber: candidate.whatsappNumber,
            certificateSentDate: candidate.certificateSentDate, 
            certificateSentBy: candidate.certificateSentBy,
            documentId: candidate.certificateDocumentId,
            cloudinaryUrl: candidate.certificateCloudinaryUrl,
            cloudinaryPublicId: candidate.certificateCloudinaryPublicId,
            storageMethod: 'cloudinary'
          },
          checkedAt: new Date().toISOString(),
          checkedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

      console.log(`📝 Generating and sending certificate for ${candidate.name} via Cloudinary by saikiran11461`);
      

      const certificatePath = tempDir;
      const result = await sendCertificateWithCloudinary(candidate, certificatePath);
      
      if (!result.success) {
        console.error(` Failed to send certificate to ${candidate.name} by saikiran11461:`, result.error);
        return res.status(500).json({
          status: "error",
          message: `Failed to send certificate: ${result.error}`,
          details: result,
          candidateId: candidateId,
          candidateName: candidate.name,
          timestamp: new Date().toISOString(),
          processedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

    
      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true,
        certificateSentDate: new Date(),
        certificateSentBy: 'saikiran11461',
        certificateDocumentId: result.documentId,
        certificateCloudinaryUrl: result.cloudinary.url,
        certificateCloudinaryPublicId: result.cloudinary.publicId,
        certificateCloudinaryAssetId: result.cloudinary.assetId,
        certificateFileName: `${result.documentId}.pdf`,
        certificateFileSize: result.cloudinary.size,
        certificateStorageMethod: 'cloudinary',
        certificateWhatsAppMessageId: result.messageId,
        certificateWhatsAppStatus: result.status,
        certificateDeliveryMethod: result.method,
        updatedAt: new Date(),
        updatedBy: 'saikiran11461'
      });

      console.log(` Certificate sent successfully to ${candidate.name} by saikiran11461 - Document ID: ${result.documentId}, Cloudinary URL: ${result.cloudinary.url}`);

      return res.json({
        status: "success",
        message: `Certificate sent successfully to ${candidate.name}`,
        candidate: {
          id: candidate._id, 
          name: candidate.name, 
          email: candidate.email,
          whatsappNumber: candidate.whatsappNumber,
          college: candidate.college,
          course: candidate.course,
          certificateSentDate: new Date().toISOString(),
          documentId: result.documentId,
          cloudinaryUrl: result.cloudinary.url,
          cloudinaryPublicId: result.cloudinary.publicId,
          cloudinaryAssetId: result.cloudinary.assetId,
          fileSize: result.cloudinary.size,
          storageMethod: 'cloudinary'
        },
        whatsapp: {
          messageId: result.messageId,
          status: result.status,
          method: result.method
        },
        cloudinary: {
          url: result.cloudinary.url,
          publicId: result.cloudinary.publicId,
          assetId: result.cloudinary.assetId,
          size: result.cloudinary.size,
          folder: 'certificates',
          cloudName: 'ddmzeqpkc'
        },
        processedAt: new Date().toISOString(),
        processedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error('Error in single certificate sending by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: `Server error: ${error.message}`,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        apiVersion: "2.0.0"
      });
    }
  },

  generateSingleCertificateOnly: async (req, res) => {
    try {
      const { candidateId } = req.body;
      
      console.log(`📄 Certificate generation only requested by saikiran11461 at 2025-08-24 18:19:32 UTC for candidate ID: ${candidateId}`);
      
      const candidate = await Candidate.findById(candidateId);
      
      if (!candidate) {
        return res.status(404).json({ 
          status: "error", 
          message: "Candidate not found",
          candidateId: candidateId,
          timestamp: new Date().toISOString(),
          requestedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }
      
      if (!candidate.attendance || candidate.paymentStatus !== "Paid") {
        return res.status(400).json({ 
          status: "error", 
          message: "Candidate not eligible",
          candidate: { 
            id: candidate._id,
            name: candidate.name, 
            attendance: candidate.attendance, 
            paymentStatus: candidate.paymentStatus 
          },
          timestamp: new Date().toISOString(),
          checkedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

      const documentId = generateDocumentId(candidate.name);
      const outputPath = path.join(tempDir, `${documentId}.pdf`);
      
      console.log(`📝 Generating certificate PDF for ${candidate.name} by saikiran11461`);
      const certData = await generateCertificatePDF(candidate.name, outputPath, documentId);

      console.log(`✅ Certificate generated for ${candidate.name} by saikiran11461 - Document ID: ${documentId}`);

      return res.json({ 
        status: "success", 
        path: certData.outputPath, 
        candidate: {
          id: candidate._id,
          name: candidate.name,
          email: candidate.email,
          whatsappNumber: candidate.whatsappNumber
        },
        certificate: {
          documentId: documentId,
          fileName: certData.fileName,
          fileSize: certData.fileSize,
          outputPath: certData.outputPath
        },
        generatedAt: new Date().toISOString(),
        generatedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Error generating certificate by saikiran11461:', error);
      return res.status(500).json({ 
        status: "error", 
        message: error.message,
        candidateId: req.body.candidateId,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  getCertificateByDocumentId: async (req, res) => {
    try {
      const { documentId } = req.params;
      
      console.log(`🔍 Certificate lookup by Document ID: ${documentId} requested by saikiran11461 at 2025-08-24 18:19:32 UTC`);
      

      const candidate = await Candidate.findOne({ certificateDocumentId: documentId });
      
      if (!candidate) {
        console.log(` Certificate not found in database for Document ID: ${documentId}`);
        return res.status(404).json({
          status: "error",
          message: "Certificate not found in database",
          documentId: documentId,
          timestamp: new Date().toISOString(),
          searchedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

      console.log(`✅ Certificate found for ${candidate.name} - Document ID: ${documentId}`);


      let cloudinaryDirectUrl = null;
      let cloudinaryViewUrl = null;
      if (candidate.certificateCloudinaryPublicId) {
        cloudinaryDirectUrl = `https://res.cloudinary.com/ddmzeqpkc/image/upload/${candidate.certificateCloudinaryPublicId}.pdf`;
        cloudinaryViewUrl = `https://res.cloudinary.com/ddmzeqpkc/image/upload/v1756058000/${candidate.certificateCloudinaryPublicId}.pdf`;
      }
      
      return res.json({
        status: "success",
        certificate: {
          documentId: documentId,
          candidate: {
            id: candidate._id,
            name: candidate.name,
            email: candidate.email,
            whatsappNumber: candidate.whatsappNumber,
            college: candidate.college,
            course: candidate.course,
            gender: candidate.gender
          },
          certificateData: {
            sentDate: candidate.certificateSentDate,
            sentBy: candidate.certificateSentBy,
            cloudinaryUrl: candidate.certificateCloudinaryUrl,
            cloudinaryPublicId: candidate.certificateCloudinaryPublicId,
            cloudinaryAssetId: candidate.certificateCloudinaryAssetId,
            fileName: candidate.certificateFileName,
            fileSize: candidate.certificateFileSize,
            storageMethod: candidate.certificateStorageMethod || 'cloudinary',
            whatsappMessageId: candidate.certificateWhatsAppMessageId,
            whatsappStatus: candidate.certificateWhatsAppStatus,
            deliveryMethod: candidate.certificateDeliveryMethod
          },
          cloudinaryInfo: {
            directUrl: cloudinaryDirectUrl,
            viewUrl: cloudinaryViewUrl,
            publicId: candidate.certificateCloudinaryPublicId,
            assetId: candidate.certificateCloudinaryAssetId,
            cloudName: 'ddmzeqpkc',
            folder: 'certificates'
          }
        },
        storageMethod: "cloudinary",
        fetchedAt: new Date().toISOString(),
        fetchedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Error retrieving certificate by Document ID by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: error.message,
        documentId: req.params.documentId,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  getCertificateStatistics: async (req, res) => {
    try {
      console.log(` Certificate statistics requested by saikiran11461 at 2025-08-24 18:19:32 UTC`);
      
      const totalEligible = await Candidate.countDocuments({ attendance: true, paymentStatus: "Paid" });
      const totalSent = await Candidate.countDocuments({ 
        attendance: true, 
        paymentStatus: "Paid", 
        certificateSent: true 
      });
      const totalPending = totalEligible - totalSent;
      const cloudinaryCount = await Candidate.countDocuments({ 
        certificateCloudinaryUrl: { $exists: true, $ne: null } 
      });
      

      const pdfDeliveries = await Candidate.countDocuments({ certificateDeliveryMethod: 'pdf_attachment' });
      const textDeliveries = await Candidate.countDocuments({ certificateDeliveryMethod: 'text_message' });
      
      const recentCertificates = await Candidate.find(
        { certificateSent: true },
        {
          name: 1, certificateSentDate: 1, certificateDocumentId: 1, 
          certificateCloudinaryUrl: 1, certificateSentBy: 1, certificateDeliveryMethod: 1,
          certificateWhatsAppStatus: 1
        }
      ).sort({ certificateSentDate: -1 }).limit(10);

      const statistics = {
        overview: {
          totalEligible,
          totalSent,
          totalPending,
          completionRate: totalEligible > 0 ? ((totalSent / totalEligible) * 100).toFixed(2) + '%' : '0%'
        },
        storage: {
          cloudinaryCount,
          storageMethod: 'cloudinary',
          cloudName: 'ddmzeqpkc',
          folder: 'certificates'
        },
        delivery: {
          pdfAttachments: pdfDeliveries,
          textMessages: textDeliveries,
          totalDelivered: pdfDeliveries + textDeliveries
        },
        recent: recentCertificates
      };

      return res.json({
        status: "success",
        statistics,
        fetchedAt: new Date().toISOString(),
        fetchedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Error fetching certificate statistics by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: error.message,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  resendCertificate: async (req, res) => {
    try {
      const { candidateId } = req.body;
      
      console.log(`🔄 Certificate resend requested by saikiran11461 at 2025-08-24 18:19:32 UTC for candidate ID: ${candidateId}`);
      
      const candidate = await Candidate.findById(candidateId);

      if (!candidate) {
        return res.status(404).json({ 
          status: "error", 
          message: "Candidate not found", 
          candidateId: candidateId,
          timestamp: new Date().toISOString(),
          requestedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }
      
      if (!candidate.attendance || candidate.paymentStatus !== "Paid") {
        return res.status(400).json({
          status: "error",
          message: "Candidate not eligible for certificate",
          candidate: { 
            id: candidate._id,
            name: candidate.name, 
            attendance: candidate.attendance, 
            paymentStatus: candidate.paymentStatus 
          },
          timestamp: new Date().toISOString(),
          checkedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }


      const oldDocumentId = candidate.certificateDocumentId;
      const oldCloudinaryUrl = candidate.certificateCloudinaryUrl;

      console.log(`🔄 Regenerating certificate for ${candidate.name} (replacing ${oldDocumentId}) by saikiran11461`);

 
      const certificatePath = tempDir;
      const result = await sendCertificateWithCloudinary(candidate, certificatePath);
      
      if (!result.success) {
        return res.status(500).json({
          status: "error",
          message: `Failed to resend certificate: ${result.error}`,
          candidateId: candidateId,
          candidateName: candidate.name,
          timestamp: new Date().toISOString(),
          processedBy: 'saikiran11461',
          apiVersion: "2.0.0"
        });
      }

    
      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true,
        certificateSentDate: new Date(),
        certificateSentBy: 'saikiran11461',
        certificateDocumentId: result.documentId,
        certificateCloudinaryUrl: result.cloudinary.url,
        certificateCloudinaryPublicId: result.cloudinary.publicId,
        certificateCloudinaryAssetId: result.cloudinary.assetId,
        certificateFileName: `${result.documentId}.pdf`,
        certificateFileSize: result.cloudinary.size,
        certificateStorageMethod: 'cloudinary',
        certificateWhatsAppMessageId: result.messageId,
        certificateWhatsAppStatus: result.status,
        certificateDeliveryMethod: result.method,
        updatedAt: new Date(),
        updatedBy: 'saikiran11461'
      });

      console.log(` Certificate resent successfully to ${candidate.name} by saikiran11461 - New Document ID: ${result.documentId}`);

      return res.json({
        status: "success",
        message: `Certificate resent successfully to ${candidate.name}`,
        candidate: {
          id: candidate._id,
          name: candidate.name,
          email: candidate.email,
          whatsappNumber: candidate.whatsappNumber
        },
        oldCertificate: {
          documentId: oldDocumentId,
          cloudinaryUrl: oldCloudinaryUrl
        },
        newCertificate: {
          documentId: result.documentId,
          cloudinaryUrl: result.cloudinary.url,
          cloudinaryPublicId: result.cloudinary.publicId,
          whatsappMessageId: result.messageId,
          whatsappStatus: result.status,
          deliveryMethod: result.method
        },
        processedAt: new Date().toISOString(),
        processedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });

    } catch (error) {
      console.error(' Error resending certificate by saikiran11461:', error);
      return res.status(500).json({
        status: "error",
        message: error.message,
        candidateId: req.body.candidateId,
        timestamp: new Date().toISOString(),
        requestedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },

  getCertificateSystemHealth: async (req, res) => {
    try {
      console.log(`🏥 Certificate system health check by saikiran11461 at 2025-08-24 18:19:32 UTC`);
      
      const cloudinaryTest = await testCloudinaryConnection();
      const whatsappTest = await testWhatsAppConnection();
      
  
      const dbCheck = await Candidate.countDocuments().limit(1);
      const dbHealthy = dbCheck >= 0;
      
      const tempDirExists = fs.existsSync(tempDir);
      
      const overallHealth = cloudinaryTest.success && whatsappTest.success && dbHealthy && tempDirExists;
      
      res.json({
        status: "success",
        health: {
          overall: overallHealth ? 'healthy' : 'degraded',
          cloudinary: cloudinaryTest.success ? 'healthy' : 'unhealthy',
          whatsapp: whatsappTest.success ? 'healthy' : 'unhealthy',
          database: dbHealthy ? 'healthy' : 'unhealthy',
          tempDirectory: tempDirExists ? 'healthy' : 'unhealthy'
        },
        details: {
          cloudinary: cloudinaryTest,
          whatsapp: whatsappTest,
          database: { connected: dbHealthy },
          tempDirectory: { 
            exists: tempDirExists, 
            path: tempDir 
          }
        },
        configuration: {
          cloudName: 'ddmzeqpkc',
          certificateFolder: 'certificates',
          storageMethod: 'cloudinary'
        },
        checkedAt: new Date().toISOString(),
        checkedBy: 'saikiran11461',
        serverTime: new Date().toISOString(),
        apiVersion: "2.0.0"
      });
    } catch (error) {
      console.error(' Certificate system health check failed by saikiran11461:', error);
      res.status(500).json({
        status: "error",
        message: error.message,
        health: {
          overall: 'unhealthy'
        },
        timestamp: new Date().toISOString(),
        checkedBy: 'saikiran11461',
        apiVersion: "2.0.0"
      });
    }
  },



};


module.exports = { CandidateController };