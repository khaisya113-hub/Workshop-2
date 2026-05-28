// backend/controllers/drugRequestController.ts
import { Request, Response } from "express";
import { db } from "../db";

// Get all drug requests
export const getDrugRequests = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT 
        r.RequestID as id,
        r.RequestedQuantity as quantity,
        r.Urgency,
        r.Supplier,
        r.Status,
        r.RequestedAt as date,
        r.Notes as reason,
        d.DrugName,
        d.Category,
        d.QuantityInStock,
        u.Name as pharmacist
      FROM reorderrequest r
      JOIN drug d ON r.DrugID = d.DrugID
      JOIN useraccount u ON r.RequestedBy = u.UserID
      WHERE d.IsActive = 1
    `;
    
    const params: any[] = [];
    
    if (status && status !== 'all') {
      query += ` AND r.Status = ?`;
      params.push(status);
    }
    
    query += ` ORDER BY 
      CASE r.Urgency
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END, 
      r.RequestedAt DESC`;
    
    const [rows] = await db.query(query, params);
    
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching drug requests:', error);
    res.status(500).json({ 
      error: 'Failed to fetch drug requests',
      details: error.message 
    });
  }
};

// Update drug request status
export const updateDrugRequestStatus = async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { status, notes } = req.body;
    const { userId } = req as any; // Assuming you have user info in request
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    // Check if request exists
    const [existingRequest]: any = await db.query(
      'SELECT * FROM reorderrequest WHERE RequestID = ?',
      [requestId]
    );
    
    if (existingRequest.length === 0) {
      return res.status(404).json({ error: 'Drug request not found' });
    }
    
    // Update status
    await db.query(
      `UPDATE reorderrequest 
       SET Status = ?, 
           Notes = CONCAT(IFNULL(Notes, ''), '\\nStatus updated to ${status}: ${notes || ''}')
       WHERE RequestID = ?`,
      [status, requestId]
    );
    
    // Log the update
    await db.query(
      `INSERT INTO inventorylog 
       (Action, QuantityChange, Timestamp, DrugID, PerformedBy) 
       VALUES (?, ?, NOW(), ?, ?)`,
      ['status-update', 0, existingRequest[0].DrugID, userId || 1]
    );
    
    res.json({ 
      success: true, 
      message: `Drug request ${status} successfully` 
    });
    
  } catch (error: any) {
    console.error('Error updating drug request:', error);
    res.status(500).json({ 
      error: 'Failed to update drug request',
      details: error.message 
    });
  }
};

// Create new drug request (if needed)
export const createDrugRequest = async (req: Request, res: Response) => {
  try {
    const { drugId, quantity, urgency, supplier, reason, requestedBy } = req.body;
    
    if (!drugId || !quantity || !requestedBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const query = `
      INSERT INTO reorderrequest 
      (DrugID, RequestedQuantity, Urgency, Supplier, RequestedBy, Status, Notes)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `;
    
    const [result]: any = await db.query(query, [
      drugId, 
      quantity, 
      urgency || 'medium', 
      supplier, 
      requestedBy, 
      reason
    ]);
    
    res.status(201).json({ 
      success: true, 
      requestId: result.insertId,
      message: 'Drug request created successfully' 
    });
    
  } catch (error: any) {
    console.error('Error creating drug request:', error);
    res.status(500).json({ 
      error: 'Failed to create drug request',
      details: error.message 
    });
  }
};

// Get drug request statistics
export const getDrugRequestStats = async (req: Request, res: Response) => {
  try {
    const [stats]: any = await db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN Status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN Status = 'ordered' THEN 1 ELSE 0 END) as ordered,
        SUM(CASE WHEN Status = 'received' THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN Status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM reorderrequest
      WHERE DATE(RequestedAt) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `);
    
    res.json(stats[0] || {});
  } catch (error: any) {
    console.error('Error fetching drug request stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch drug request statistics',
      details: error.message 
    });
  }
};