import { Request, Response } from "express";
import { db } from "../db";

export const getDrugs = async (req: Request, res: Response) => {
  try {
    const [drugs]: any = await db.query("SELECT * FROM drug WHERE IsActive = 1");
    res.json(drugs);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * FIXED: Fetch prescriptions with Aliases for the Pharmacy Queue
 * Logic: Joins patient and doctor names to avoid blank cards
 */
export const getPendingPrescriptions = async (req: Request, res: Response) => {
  try {
    const [list]: any = await db.query(`
      SELECT 
        p.PrescriptionID AS id,
        pi.ItemID,
        pat.Name AS patient,
        u.Name AS doctor,
        d.DrugName AS medication,
        pi.Quantity AS quantity,
        pi.Status AS status
      FROM prescriptionitem pi
      JOIN drug d ON pi.DrugID = d.DrugID
      JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
      JOIN patient pat ON p.PatientID = pat.PatientID
      JOIN useraccount u ON p.DoctorID = u.UserID
      WHERE pi.Status = 'Pending'
    `);
    res.json(list);
  } catch (error) {
    console.error("Queue Fetch Error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const dispenseMedication = async (req: Request, res: Response) => {
  const { itemId } = req.params;
  try {
    await db.query("START TRANSACTION");
    await db.query("UPDATE prescriptionitem SET Status = 'Dispensed' WHERE ItemID = ?", [itemId]);
    await db.query(`
      UPDATE drug d 
      JOIN prescriptionitem pi ON d.DrugID = pi.DrugID 
      SET d.QuantityInStock = d.QuantityInStock - pi.Quantity 
      WHERE pi.ItemID = ?
    `, [itemId]);
    await db.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await db.query("ROLLBACK");
    res.status(500).json({ success: false });
  }
};

// pharmacistController.ts
export const dispensePrescriptionItem = async (req: Request, res: Response) => {
  try {
    const { itemId, batchNumber, quantityDispensed, notes } = req.body;
    const pharmacistId = (req as any).user?.userId;
    
    if (!pharmacistId) {
      return res.status(400).json({ error: "Pharmacist ID not found" });
    }
    
    if (!itemId || !quantityDispensed) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    await db.query("START TRANSACTION");
    
    // 1. Get prescription item details
    const [itemDetails]: any = await db.query(`
      SELECT pi.*, d.QuantityInStock, d.DrugName
      FROM prescriptionitem pi
      JOIN drug d ON pi.DrugID = d.DrugID
      WHERE pi.ItemID = ?
    `, [itemId]);
    
    if (itemDetails.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Prescription item not found" });
    }
    
    const item = itemDetails[0];
    
    // 2. Check if already dispensed
    if (item.Status === 'dispensed') {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: "Item already dispensed" });
    }
    
    // 3. Check stock availability
    if (item.QuantityInStock < quantityDispensed) {
      await db.query("ROLLBACK");
      return res.status(400).json({ 
        error: `Insufficient stock. Available: ${item.QuantityInStock}, Requested: ${quantityDispensed}` 
      });
    }
    
    // 4. Update drug inventory
    await db.query(`
      UPDATE drug 
      SET QuantityInStock = QuantityInStock - ?,
          LastUpdated = NOW()
      WHERE DrugID = ?
    `, [quantityDispensed, item.DrugID]);
    
    // 5. Log inventory change
    await db.query(`
      INSERT INTO inventorylog 
      (DrugID, Action, QuantityChange, Timestamp, PerformedBy)
      VALUES (?, 'dispensed', -?, NOW(), ?)
    `, [item.DrugID, quantityDispensed, pharmacistId]);
    
    // 6. Update prescription item status
    await db.query(`
      UPDATE prescriptionitem 
      SET Status = 'dispensed',
          StatusUpdatedAt = NOW(),
          StatusUpdatedBy = ?
      WHERE ItemID = ?
    `, [pharmacistId, itemId]);
    
    // 7. Create dispensing record
    const [dispensingRecord]: any = await db.query(`
      INSERT INTO dispensingrecord 
      (PrescriptionID, ItemID, PharmacistID, DispensedDate, BatchNumber, QuantityDispensed, Notes)
      VALUES (?, ?, ?, NOW(), ?, ?, ?)
    `, [item.PrescriptionID, itemId, pharmacistId, batchNumber, quantityDispensed, notes]);
    
    await db.query("COMMIT");
    
    res.status(200).json({
      success: true,
      message: "Medication dispensed successfully",
      dispensingId: dispensingRecord.insertId
    });
    
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Dispensing error:", error);
    res.status(500).json({ error: "Failed to dispense medication" });
  }
};

export const updatePrescriptionItemStatus = async (req: Request, res: Response) => {
  try {
    const { itemId, status, notes } = req.body;
    const updatedBy = (req as any).user?.userId;
    
    if (!updatedBy) {
      return res.status(400).json({ error: "User ID not found" });
    }
    
    const validStatuses = ['pending', 'preparing', 'ready', 'dispensed', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    
    await db.query(`
      UPDATE prescriptionitem 
      SET Status = ?,
          StatusUpdatedAt = NOW(),
          StatusUpdatedBy = ?,
          StatusNotes = CONCAT(IFNULL(StatusNotes, ''), '\n', ?)
      WHERE ItemID = ?
    `, [status, updatedBy, notes || `Status changed to ${status}`, itemId]);
    
    res.json({
      success: true,
      message: `Status updated to ${status}`
    });
    
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ error: "Failed to update status" });
  }
};