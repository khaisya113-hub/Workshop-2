// backend/controllers/drugController.ts
import { Request, Response } from "express";
import { db } from "../db";

// Get all drugs with optional search
export const getDrugs = async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    
    let query = `
      SELECT 
        DrugID,
        DrugName,
        Category,
        UnitPrice,
        QuantityInStock,
        ExpiryDate,
        Location,
        Supplier,
        BatchNumber,
        MinStockLevel,
        IsActive
      FROM drug 
      WHERE IsActive = 1
    `;
    
    const params: any[] = [];
    
    if (search && typeof search === 'string' && search.trim() !== '') {
      query += ` AND (
        DrugName LIKE ? OR 
        Category LIKE ? OR 
        Location LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    query += ` ORDER BY DrugName ASC LIMIT 100`;
    
    const [rows] = await db.query(query, params);
    
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching drugs:', error);
    res.status(500).json({ 
      error: 'Failed to fetch medications',
      details: error.message 
    });
  }
};

// Get drug by ID
export const getDrugById = async (req: Request, res: Response) => {
  try {
    const drugId = req.params.id;
    
    const query = `
      SELECT 
        DrugID,
        DrugName,
        Category,
        UnitPrice,
        QuantityInStock,
        ExpiryDate,
        Location,
        Supplier,
        BatchNumber,
        MinStockLevel,
        IsActive
      FROM drug 
      WHERE DrugID = ? AND IsActive = 1
    `;
    
    const [rows] = await db.query(query, [drugId]);
    
    if (Array.isArray(rows) && rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.status(404).json({ error: 'Drug not found' });
    }
  } catch (error: any) {
    console.error('Error fetching drug:', error);
    res.status(500).json({ 
      error: 'Failed to fetch drug details',
      details: error.message 
    });
  }
};


// 1. GET Pending Prescriptions (Now includes DispensedCount)
export const getPendingPrescriptions = async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
        pi.ItemID as itemId,
        pi.Status as status,
        pi.Quantity as quantity,
        pi.DispensedCount as dispensedCount, /* 👈 NEW FIELD */
        pi.Dosage as dosage,
        d.DrugName as medication,
        d.BarcodeID as barcode, 
        p.PrescriptionID as prescriptionId,
        p.PrescribedDate as date,
        COALESCE(pat.Name, 'Unknown Patient') as patient,
        COALESCE(doc.Name, 'Unknown Doctor') as doctor
      FROM prescriptionitem pi
      LEFT JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
      LEFT JOIN drug d ON pi.DrugID = d.DrugID
      LEFT JOIN patient pat ON p.PatientID = pat.PatientID
      LEFT JOIN useraccount doc ON p.DoctorID = doc.UserID
      WHERE pi.Status = 'pending'
      ORDER BY p.PrescribedDate ASC
    `;

    const [rows]: any[] = await db.query(query);

    const grouped = rows.reduce((acc: any, row: any) => {
      const { prescriptionId, patient, doctor, date, ...item } = row;
      if (!acc[prescriptionId]) {
        acc[prescriptionId] = { prescriptionId, patient, doctor, date, items: [] };
      }
      acc[prescriptionId].items.push(item);
      return acc;
    }, {});

    res.json(Object.values(grouped));
  } catch (error: any) {
    console.error('Error fetching prescriptions:', error);
    res.status(500).json({ error: 'Failed to fetch prescriptions' });
  }
};

// 2. SCAN ITEM (One-by-One Logic)
export const scanDispenseItem = async (req: Request, res: Response) => {
  const connection = await db.getConnection();
  try {
    const { itemId, barcode } = req.body; 
    await connection.beginTransaction();

    // A. Get Item & Verify (including PrescriptionID for later use)
    const [itemCheck]: any[] = await connection.query(
      `SELECT pi.Quantity, pi.DispensedCount, pi.DrugID, pi.PrescriptionID, 
              d.BarcodeID, d.QuantityInStock 
       FROM prescriptionitem pi
       JOIN drug d ON pi.DrugID = d.DrugID
       WHERE pi.ItemID = ? FOR UPDATE`, [itemId]
    );

    if (itemCheck.length === 0) throw new Error("Item not found");
    const item = itemCheck[0];

    if (item.BarcodeID !== barcode) throw new Error("Wrong Barcode");
    if (item.QuantityInStock < 1) throw new Error("Out of Stock");

    // B. FIFO DEDUCTION (The Real Life Logic)
    const [batches]: any[] = await connection.query(
      `SELECT BatchID FROM drug_batches 
       WHERE DrugID = ? AND Quantity > 0 
       ORDER BY ExpiryDate ASC LIMIT 1 FOR UPDATE`,
      [item.DrugID]
    );

    if (batches.length === 0) {
        console.warn("Stock mismatch: Main table has stock, but no batch found.");
    } else {
        await connection.query(
            `UPDATE drug_batches SET Quantity = Quantity - 1 WHERE BatchID = ?`,
            [batches[0].BatchID]
        );
    }

    // C. Deduct Main Inventory Total
    await connection.query(
      `UPDATE drug SET QuantityInStock = QuantityInStock - 1 WHERE DrugID = ?`, 
      [item.DrugID]
    );

    // D. Update Prescription Progress
    await connection.query(
      `UPDATE prescriptionitem SET DispensedCount = DispensedCount + 1 WHERE ItemID = ?`, 
      [itemId]
    );

    // E. Check if ALL items in the prescription are now dispensed
    const newCount = item.DispensedCount + 1;
    let allItemsDispensed = false;
    
    if (newCount >= item.Quantity) {
        await connection.query(`UPDATE prescriptionitem SET Status = 'dispensed' WHERE ItemID = ?`, [itemId]);
        
        // Check if ALL items in this prescription are dispensed
        const [prescriptionItems]: any[] = await connection.query(
          `SELECT Status FROM prescriptionitem WHERE PrescriptionID = ?`,
          [item.PrescriptionID]
        );
        
        allItemsDispensed = prescriptionItems.length > 0 && 
                           prescriptionItems.every((item: any) => item.Status === 'dispensed');
    }

    // F. If all items are dispensed, update patient visit and queue status
    if (allItemsDispensed) {
        // Get ConsultationID from Prescription
        const [prescriptionData]: any[] = await connection.query(
          `SELECT ConsultationID FROM prescription WHERE PrescriptionID = ?`,
          [item.PrescriptionID]
        );
        
        if (prescriptionData.length > 0) {
            const consultationID = prescriptionData[0].ConsultationID;
            
            // Get VisitID from Consultation
            const [consultationData]: any[] = await connection.query(
              `SELECT VisitID FROM consultation WHERE ConsultationID = ?`,
              [consultationID]
            );
            
            if (consultationData.length > 0) {
                const visitID = consultationData[0].VisitID;
                
                // Update patient_visit table statuses
                await connection.query(
                  `UPDATE patient_visit 
                   SET VisitStatus = 'to-be-billed', 
                       QueueStatus = 'waiting'
                   WHERE VisitID = ?`,
                  [visitID]
                );
                
                console.log(`Updated visit ${visitID} status to 'to be billed' and queue to 'waiting'`);
            }
        }
    }

    await connection.commit();
    res.json({ 
      success: true, 
      newCount, 
      allItemsDispensed,
      visitStatusUpdated: allItemsDispensed 
    });

  } catch (error: any) {
    await connection.rollback();
    res.status(500).json({ error: error.message || "Scan failed" });
  } finally {
    connection.release();
  }
};

// 3. GET Dispensing History (Fixes the 404 error)
export const getDispensingHistory = async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
        p.PrescribedDate as date,
        pat.Name as patient,
        d.DrugName as medication,
        pi.Quantity as quantity
      FROM prescriptionitem pi
      JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
      JOIN patient pat ON p.PatientID = pat.PatientID
      JOIN drug d ON pi.DrugID = d.DrugID
      WHERE pi.Status = 'dispensed'
      ORDER BY p.PrescribedDate DESC
      LIMIT 50
    `;
    const [rows] = await db.query(query);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

export const dispensePrescriptionItem = async (req: Request, res: Response) => {
  try {
    const { id } = req.params; // ItemID
    const { notes, pharmacistId } = req.body;
    
    console.log(`🚀 Dispensing prescription item ID: ${id}`);

    // Start transaction
    await db.query("START TRANSACTION");

    // 1. Get the item details first - using a simpler approach
    const itemQuery = `
      SELECT 
        pi.ItemID,
        pi.DrugID,
        pi.Quantity,
        pi.PrescriptionID as ItemPrescriptionID,
        pr.PrescriptionID,
        pr.VisitID,
        pr.ConsultationID,
        pr.PatientID
      FROM prescriptionitem pi
      JOIN prescription pr ON pi.PrescriptionID = pr.PrescriptionID
      WHERE pi.ItemID = ?
    `;
    
    const result: any = await db.query(itemQuery, [id]);
    
    // mysql2 returns [rows, fields] structure
    console.log('📊 Result type:', typeof result);
    console.log('📊 Result is array:', Array.isArray(result));
    console.log('📊 Result length:', result.length);
    
    let rows = [];
    if (Array.isArray(result)) {
      // mysql2 returns [rows, fields]
      rows = result[0] || [];
      const fields = result[1] || [];
      console.log('📊 Number of rows:', rows.length);
      console.log('📊 Number of fields:', fields.length);
    }
    
    if (rows.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: 'Prescription item not found' });
    }
    
    const itemData = rows[0];
    console.log('📊 Item data:', itemData);
    
    // Try to get PrescriptionID from any possible property name
    const prescriptionId = itemData.PrescriptionID || itemData.ItemPrescriptionID;
    const visitId = itemData.VisitID;
    const consultationId = itemData.ConsultationID;
    const drugId = itemData.DrugID;
    const quantity = itemData.Quantity;
    
    console.log(`📋 Extracted: PrescriptionID=${prescriptionId}, VisitID=${visitId}, DrugID=${drugId}, Quantity=${quantity}`);
    
    if (!prescriptionId) {
      console.error('❌ PrescriptionID is null or undefined!');
      console.error('❌ Available properties:', Object.keys(itemData));
      await db.query("ROLLBACK");
      return res.status(500).json({ 
        error: 'Could not find PrescriptionID',
        debug: { itemData }
      });
    }

    // 2. Update prescription item status
    const updateResult = await db.query(
      `UPDATE prescriptionitem 
       SET Status = 'dispensed', 
           StatusNotes = ?,
           StatusUpdatedAt = NOW(),
           StatusUpdatedBy = ?
       WHERE ItemID = ?`,
      [notes, pharmacistId, id]
    );
    
    console.log('✅ Prescription item updated');

    // 3. Update drug inventory (reduce quantity)
    if (drugId && quantity) {
      await db.query(`
        UPDATE drug 
        SET QuantityInStock = QuantityInStock - ? 
        WHERE DrugID = ?
      `, [quantity, drugId]);
      console.log('✅ Inventory updated');
    }

    // 4. Create dispensing record
    if (prescriptionId) {
      await db.query(`
        INSERT INTO dispensingrecord 
        (PrescriptionID, PharmacistID, DispensedDate, BatchNumber, QuantityDispensed, Notes, ItemID)
        VALUES (?, ?, NOW(), 'BATCH-${Date.now()}', ?, ?, ?)
      `, [prescriptionId, pharmacistId, quantity, notes, id]);
      console.log('✅ Dispensing record created');
    }

    // 5. Log inventory change
    if (drugId && quantity) {
      await db.query(`
        INSERT INTO inventorylog 
        (Action, QuantityChange, Timestamp, DrugID, PerformedBy)
        VALUES ('dispensed', -?, NOW(), ?, ?)
      `, [quantity, drugId, pharmacistId]);
      console.log('✅ Inventory log created');
    }

    let pendingCount = 0;
    let finalVisitId = visitId;

    // 6. Check if all prescription items for this visit are dispensed
    if (visitId) {
      console.log(`🔍 Checking pending prescriptions for VisitID: ${visitId}`);
      
      const pendingQuery = `
        SELECT COUNT(*) as pendingCount
        FROM prescriptionitem pi
        JOIN prescription pr ON pi.PrescriptionID = pr.PrescriptionID
        WHERE pr.VisitID = ?
          AND pi.Status IN ('pending', 'preparing', 'ready')
      `;
      
      const pendingResult: any = await db.query(pendingQuery, [visitId]);
      const pendingRows = pendingResult[0] || [];
      
      if (pendingRows.length > 0) {
        pendingCount = pendingRows[0].pendingCount || 0;
      }
      
      console.log(`📊 Visit ${visitId} has ${pendingCount} pending prescription(s)`);
      
      if (pendingCount === 0) {
        console.log(`🔄 All prescriptions dispensed for VisitID: ${visitId}, updating status...`);
        
        await db.query(`
          UPDATE patient_visit 
          SET 
            VisitStatus = 'to-be-billed',
            QueueStatus = 'waiting',
            UpdatedAt = NOW()
          WHERE VisitID = ? 
            AND (VisitStatus = 'waiting-prescription' OR VisitStatus = 'waiting for prescription')
        `, [visitId]);
        
        console.log(`✅ Visit ${visitId} status updated to 'to-be-billed'`);
      }
    }

    await db.query("COMMIT");
    console.log('✅ Transaction committed successfully');
    
    res.json({ 
      success: true, 
      message: 'Medication dispensed successfully',
      visitUpdated: pendingCount === 0,
      visitId: finalVisitId
    });

  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error('❌ Error dispensing:', error);
    res.status(500).json({ 
      error: 'Failed to dispense',
      details: error.message,
      sql: error.sql
    });
  }
};

// Search drugs with advanced filters
export const searchDrugs = async (req: Request, res: Response) => {
  try {
    const { 
      q, // search query
      category,
      minStock,
      maxStock,
      expiresWithin,
      sortBy = 'name',
      sortOrder = 'asc'
    } = req.query;
    
    let query = `
      SELECT 
        DrugID,
        DrugName,
        Category,
        UnitPrice,
        QuantityInStock,
        ExpiryDate,
        Location,
        Supplier,
        BatchNumber,
        MinStockLevel,
        IsActive,
        CASE 
          WHEN QuantityInStock <= MinStockLevel * 0.2 THEN 'critical'
          WHEN QuantityInStock <= MinStockLevel * 0.5 THEN 'low'
          ELSE 'adequate'
        END as StockStatus,
        DATEDIFF(ExpiryDate, CURDATE()) as DaysUntilExpiry
      FROM drug 
      WHERE IsActive = 1
    `;

    
    
    const params: any[] = [];
    const conditions: string[] = [];
    
    // Search by name or category
    if (q && typeof q === 'string' && q.trim() !== '') {
      conditions.push(`(DrugName LIKE ? OR Category LIKE ? OR Supplier LIKE ?)`);
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    // Filter by category
    if (category && typeof category === 'string') {
      conditions.push(`Category = ?`);
      params.push(category);
    }
    
    // Filter by minimum stock
    if (minStock && !isNaN(Number(minStock))) {
      conditions.push(`QuantityInStock >= ?`);
      params.push(Number(minStock));
    }
    
    // Filter by maximum stock
    if (maxStock && !isNaN(Number(maxStock))) {
      conditions.push(`QuantityInStock <= ?`);
      params.push(Number(maxStock));
    }
    
    // Filter by expiration date
    if (expiresWithin && !isNaN(Number(expiresWithin))) {
      conditions.push(`ExpiryDate IS NOT NULL AND DATEDIFF(ExpiryDate, CURDATE()) <= ?`);
      params.push(Number(expiresWithin));
    }
    
    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }
    
    // Sorting
    let orderBy = 'ORDER BY ';
    switch (sortBy) {
      case 'name':
        orderBy += 'DrugName';
        break;
      case 'category':
        orderBy += 'Category, DrugName';
        break;
      case 'stock':
        orderBy += 'QuantityInStock';
        break;
      case 'expiry':
        orderBy += 'ExpiryDate';
        break;
      default:
        orderBy += 'DrugName';
    }
    
    orderBy += ` ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
    query += ` ${orderBy} LIMIT 200`;
    
    const [rows] = await db.query(query, params);
    
    // Get distinct categories for filter suggestions
    const [categories] = await db.query(`
      SELECT DISTINCT Category 
      FROM drug 
      WHERE Category IS NOT NULL AND Category != '' 
      ORDER BY Category
    `);
    
    res.json({
      drugs: rows,
      filters: {
        categories,
        total: Array.isArray(rows) ? rows.length : 0
      }
    });
  } catch (error: any) {
    console.error('Error searching drugs:', error);
    res.status(500).json({ 
      error: 'Failed to search medications',
      details: error.message 
    });
  }
};

// 7. REGISTER NEW DRUG (With Robust Date Handling)
export const addDrug = async (req: Request, res: Response) => {
  const connection = await db.getConnection();
  try {
    const { DrugName, BarcodeID, Category, UnitPrice, QuantityInStock, MinStockLevel, ExpiryDate } = req.body;
    
    console.log(`📝 Registering: ${DrugName} (Stock: ${QuantityInStock})`); // Debug Log

    // 1. Handle Empty Date: Default to 1 Year from now if missing
    let finalExpiry = ExpiryDate;
    if (!finalExpiry || finalExpiry === '') {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 1);
        finalExpiry = d.toISOString().split('T')[0]; // "2026-01-01"
        console.log(`⚠️ No expiry chosen. Defaulting to: ${finalExpiry}`);
    }

    await connection.beginTransaction();

    // 2. Insert into Main Table
    const [result]: any = await connection.query(
      `INSERT INTO drug (DrugName, BarcodeID, Category, UnitPrice, QuantityInStock, MinStockLevel, ExpiryDate) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [DrugName, BarcodeID, Category, UnitPrice, QuantityInStock, MinStockLevel, finalExpiry]
    );
    
    const newDrugID = result.insertId;
    console.log(`✅ Main Drug Created. ID: ${newDrugID}`);

    // 3. Insert into Batch Table (The Missing Link)
    await connection.query(
      `INSERT INTO drug_batches (DrugID, BarcodeID, Quantity, ExpiryDate) VALUES (?, ?, ?, ?)`,
      [newDrugID, BarcodeID, QuantityInStock, finalExpiry]
    );
    console.log(`✅ Batch Created for ID: ${newDrugID}`);

    await connection.commit();
    res.json({ message: 'Drug and initial batch registered successfully' });

  } catch (error: any) {
    await connection.rollback();
    console.error("❌ Register Error:", error);
    res.status(500).json({ error: 'Failed to add drug', details: error.message });
  } finally {
    connection.release();
  }
};

// Get drug categories
export const getDrugCategories = async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT DISTINCT Category 
      FROM drug 
      WHERE Category IS NOT NULL AND Category != '' AND IsActive = 1
      ORDER BY Category
    `;
    
    const [rows] = await db.query(query);
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ 
      error: 'Failed to fetch categories',
      details: error.message 
    });
  }
};

// Check drug stock availability
export const checkDrugStock = async (req: Request, res: Response) => {
  try {
    const drugId = req.params.id;
    const { quantity = 1 } = req.query;
    
    const query = `
      SELECT 
        DrugID,
        DrugName,
        QuantityInStock,
        UnitPrice,
        MinStockLevel,
        CASE 
          WHEN QuantityInStock >= ? THEN 'available'
          WHEN QuantityInStock > 0 THEN 'low-stock'
          ELSE 'out-of-stock'
        END as Availability
      FROM drug 
      WHERE DrugID = ? AND IsActive = 1
    `;
    
    const [rows] = await db.query(query, [quantity, drugId]);
    
    if (Array.isArray(rows) && rows.length > 0) {
      const drug = rows[0] as any;
      res.json({
        available: drug.QuantityInStock >= Number(quantity),
        availableQuantity: drug.QuantityInStock,
        requestedQuantity: Number(quantity),
        unitPrice: drug.UnitPrice,
        totalPrice: drug.UnitPrice * Number(quantity),
        availability: drug.Availability,
        message: drug.QuantityInStock >= Number(quantity) 
          ? `Stock available (${drug.QuantityInStock} units)`
          : `Only ${drug.QuantityInStock} units available`
      });
    } else {
      res.status(404).json({ 
        available: false, 
        message: 'Drug not found or inactive' 
      });
    }
  } catch (error: any) {
    console.error('Error checking stock:', error);
    res.status(500).json({ 
      error: 'Failed to check stock',
      details: error.message 
    });
  }
};

// Save prescription
export const savePrescription = async (req: Request, res: Response) => {
  try {
    const { patientId, doctorId, consultationId, items } = req.body;
    
    if (!patientId || !doctorId || !consultationId || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Start transaction
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // Insert prescription
      const [prescriptionResult] = await connection.query(
        `INSERT INTO prescription (PrescribedDate, DoctorID, PatientID, ConsultationID, VisitID) 
         VALUES (CURDATE(), ?, ?, ?, 
           (SELECT VisitID FROM consultation WHERE ConsultationID = ? LIMIT 1))`,
        [doctorId, patientId, consultationId, consultationId]
      );
      
      const prescriptionId = (prescriptionResult as any).insertId;
      
      // Insert prescription items
      for (const item of items) {
        await connection.query(
          `INSERT INTO prescriptionitem (PrescriptionID, DrugID, Dosage, Frequency, Duration, Quantity) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [prescriptionId, item.DrugID, item.Dosage, item.Frequency, item.Duration, item.Quantity || 1]
        );
        
        // Update drug stock
        await connection.query(
          `UPDATE drug SET QuantityInStock = QuantityInStock - ? WHERE DrugID = ?`,
          [item.Quantity || 1, item.DrugID]
        );
      }
      
      await connection.commit();
      
      res.json({ 
        success: true, 
        prescriptionId,
        message: 'Prescription saved successfully' 
      });
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    
  } catch (error: any) {
    console.error('Error saving prescription:', error);
    res.status(500).json({ 
      error: 'Failed to save prescription',
      details: error.message 
    });
  }
};

// 4. GET EXPIRING DRUGS (3 Month Lookahead)
// 4. GET EXPIRING DRUGS (Now includes BatchID)
export const getExpiringDrugs = async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT 
        b.BatchID as batchId, /* 👈 NEW: We need this to delete it later */
        b.DrugID as id,
        d.DrugName as name,
        b.Quantity as stock,
        d.Location as location,
        b.ExpiryDate as expiryDate,
        DATEDIFF(b.ExpiryDate, CURDATE()) as daysLeft
      FROM drug_batches b
      JOIN drug d ON b.DrugID = d.DrugID
      WHERE b.ExpiryDate <= DATE_ADD(CURDATE(), INTERVAL 90 DAY) 
      AND b.Quantity > 0
      ORDER BY daysLeft ASC
    `;
    const [rows] = await db.query(query);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch expiry" });
  }
};

// 5. DISPOSE DRUG (Now Deletes the Batch)
export const disposeDrug = async (req: Request, res: Response) => {
  const connection = await db.getConnection();
  try {
    const { drugId, batchId, quantity, reason } = req.body; /* 👈 Expect batchId */
    
    console.log(`🗑️ Disposing Drug ${drugId} (Batch ${batchId}) - Qty: ${quantity}`);

    await connection.beginTransaction();

    // 1. Deduct Main Stock (Keep totals accurate)
    await connection.query(
      `UPDATE drug SET QuantityInStock = QuantityInStock - ? WHERE DrugID = ?`,
      [quantity, drugId]
    );

    // 2. DELETE THE BATCH (The missing step!)
    if (batchId) {
        await connection.query(
            `DELETE FROM drug_batches WHERE BatchID = ?`,
            [batchId]
        );
    }

    // 3. (Optional) Insert into a waste_log table here if you have one

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ error: "Disposal failed" });
  } finally {
    connection.release();
  }
};

// Get patient prescriptions
export const getPatientPrescriptions = async (req: Request, res: Response) => {
  try {
    const patientId = req.params.id;
    
    const query = `
      SELECT 
        p.PrescriptionID,
        p.PrescribedDate,
        p.ConsultationID,
        d.Name as DoctorName,
        pi.DrugID,
        drug.DrugName,
        pi.Dosage,
        pi.Frequency,
        pi.Duration,
        pi.Quantity,
        c.Diagnosis
      FROM prescription p
      JOIN useraccount d ON p.DoctorID = d.UserID
      JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      JOIN drug ON pi.DrugID = drug.DrugID
      LEFT JOIN consultation c ON p.ConsultationID = c.ConsultationID
      WHERE p.PatientID = ?
      ORDER BY p.PrescribedDate DESC
    `;
    
    const [rows] = await db.query(query, [patientId]);
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching prescriptions:', error);
    res.status(500).json({ error: 'Failed to fetch prescriptions' });
  }
};

// ... (previous code)

// 6. RAPID RESTOCK (Debug Version)
export const restockDrug = async (req: Request, res: Response) => {
  const connection = await db.getConnection();
  try {
    const { BarcodeID } = req.body;
    console.log(`📦 [RESTOCK START] Scanning Barcode: "${BarcodeID}"`);

    await connection.beginTransaction();

    // 1. Find Drug
    const [drugs]: any[] = await connection.query(
      `SELECT DrugID, DrugName FROM drug WHERE BarcodeID = ?`, 
      [BarcodeID]
    );

    if (drugs.length === 0) {
      await connection.rollback();
      console.log(`❌ Drug not found for barcode: ${BarcodeID}`);
      return res.status(404).json({ error: "Drug not found. Please register it first." });
    }
    const drug = drugs[0];
    console.log(`✅ Found: ${drug.DrugName} (ID: ${drug.DrugID})`);

    // 2. Find Newest Batch
    const [batches]: any[] = await connection.query(
      `SELECT BatchID FROM drug_batches WHERE DrugID = ? ORDER BY ExpiryDate DESC LIMIT 1`, 
      [drug.DrugID]
    );

    if (batches.length > 0) {
      console.log(`🔄 Adding to Batch #${batches[0].BatchID}`);
      await connection.query(
        `UPDATE drug_batches SET Quantity = Quantity + 1 WHERE BatchID = ?`,
        [batches[0].BatchID]
      );
    } else {
      console.log(`✨ Creating NEW Default Batch (1 Year Expiry)`);
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      const dateStr = nextYear.toISOString().split('T')[0];

      await connection.query(
        `INSERT INTO drug_batches (DrugID, BarcodeID, Quantity, ExpiryDate) VALUES (?, ?, 1, ?)`,
        [drug.DrugID, BarcodeID, dateStr]
      );
    }

    // 3. Update Total
    await connection.query(
      `UPDATE drug SET QuantityInStock = QuantityInStock + 1 WHERE DrugID = ?`,
      [drug.DrugID]
    );

    await connection.commit();
    console.log(`🎉 Restock Complete!`);
    res.json({ success: true, drug });

  } catch (error: any) {
    await connection.rollback();
    console.error("❌ Restock Error:", error);
    res.status(500).json({ error: "Restock failed" });
  } finally {
    connection.release();
  }
};

// 8. GET BATCHES FOR INSPECTOR
export const getDrugBatches = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Debug log to confirm request received
    console.log(`🔎 Fetching batches for Drug ID: ${id}`);

    const query = `
      SELECT 
        BatchID, 
        BarcodeID, 
        Quantity, 
        ExpiryDate, 
        ReceivedDate
      FROM drug_batches 
      WHERE DrugID = ? AND Quantity > 0
      ORDER BY ExpiryDate ASC
    `;
    
    const [rows] = await db.query(query, [id]);
    res.json(rows);
  } catch (error) {
    console.error("❌ Batch Fetch Error:", error);
    res.status(500).json({ error: "Failed to fetch batches" });
  }
};