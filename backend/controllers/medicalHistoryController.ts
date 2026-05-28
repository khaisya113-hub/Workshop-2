// src/controllers/medicalHistoryController.ts
import { Request, Response } from "express";
import { db } from "../db";
import { ResultSetHeader, RowDataPacket } from 'mysql2';

/**
 * Create a medical history entry
 */
export const createMedicalHistory = async (req: Request, res: Response) => {
  try {
    const {
      PatientID,
      ConsultationID,
      VisitID,
      RecordType,
      RecordName,
      Description,
      Status,
      StartDate,
      EndDate,
      Severity,
      Reaction,
      Dosage,
      Frequency,
      PrescribedBy,
      Notes,
      CreatedBy
    } = req.body;

    // Validate required fields
    if (!PatientID || !RecordType || !RecordName) {
      return res.status(400).json({
        success: false,
        error: "PatientID, RecordType, and RecordName are required"
      });
    }

    const query = `
      INSERT INTO medical_history (
        PatientID, ConsultationID, VisitID, RecordType, RecordName, 
        Description, Status, StartDate, EndDate, Severity, Reaction, 
        Dosage, Frequency, PrescribedBy, Notes, CreatedBy, CreatedAt, UpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;

    const [result] = await db.execute<ResultSetHeader>(query, [
      PatientID,
      ConsultationID || null,
      VisitID || null,
      RecordType,
      RecordName,
      Description || null,
      Status || 'active',
      StartDate || null,
      EndDate || null,
      Severity || null,
      Reaction || null,
      Dosage || null,
      Frequency || null,
      PrescribedBy || null,
      Notes || null,
      CreatedBy
    ]);

    res.status(201).json({ 
      success: true, 
      historyId: result.insertId,
      message: 'Medical history entry created successfully' 
    });
  } catch (error) {
    console.error('Error creating medical history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create medical history entry' 
    });
  }
};

/**
 * Get patient's medical history
 */
export const getPatientMedicalHistory = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    const query = `
      SELECT 
        mh.*,
        c.ConsultationID,
        DATE_FORMAT(mh.StartDate, '%Y-%m-%d') as FormattedStartDate,
        DATE_FORMAT(mh.EndDate, '%Y-%m-%d') as FormattedEndDate,
        DATE_FORMAT(mh.CreatedAt, '%Y-%m-%d %H:%i') as FormattedCreatedAt,
        u.Name as CreatedByName
      FROM medical_history mh
      LEFT JOIN consultation c ON mh.ConsultationID = c.ConsultationID
      LEFT JOIN useraccount u ON mh.CreatedBy = u.UserID
      WHERE mh.PatientID = ?
      ORDER BY mh.CreatedAt DESC
    `;

    const [rows] = await db.execute<RowDataPacket[]>(query, [patientId]);
    
    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    console.error('Error fetching medical history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch medical history' 
    });
  }
};

/**
 * Get medical history for a specific consultation
 */
export const getConsultationMedicalHistory = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    const query = `
      SELECT 
        mh.*,
        DATE_FORMAT(mh.StartDate, '%Y-%m-%d') as FormattedStartDate,
        DATE_FORMAT(mh.EndDate, '%Y-%m-%d') as FormattedEndDate,
        DATE_FORMAT(mh.CreatedAt, '%Y-%m-%d %H:%i') as FormattedCreatedAt,
        u.Name as CreatedByName,
        p.Name as PatientName
      FROM medical_history mh
      LEFT JOIN useraccount u ON mh.CreatedBy = u.UserID
      LEFT JOIN patient p ON mh.PatientID = p.PatientID
      WHERE mh.ConsultationID = ?
      ORDER BY mh.CreatedAt DESC
    `;

    const [rows] = await db.execute<RowDataPacket[]>(query, [consultationId]);
    
    res.json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    console.error('Error fetching consultation medical history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch consultation medical history' 
    });
  }
};

/**
 * Update a medical history entry
 */
export const updateMedicalHistory = async (req: Request, res: Response) => {
  try {
    const { historyId } = req.params;
    const {
      RecordName,
      Description,
      Status,
      StartDate,
      EndDate,
      Severity,
      Reaction,
      Dosage,
      Frequency,
      Notes
    } = req.body;

    // Check if entry exists
    const [checkRows] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM medical_history WHERE HistoryID = ?',
      [historyId]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Medical history entry not found'
      });
    }

    const query = `
      UPDATE medical_history 
      SET 
        RecordName = ?,
        Description = ?,
        Status = ?,
        StartDate = ?,
        EndDate = ?,
        Severity = ?,
        Reaction = ?,
        Dosage = ?,
        Frequency = ?,
        Notes = ?,
        UpdatedAt = NOW()
      WHERE HistoryID = ?
    `;

    await db.execute<ResultSetHeader>(query, [
      RecordName || checkRows[0].RecordName,
      Description || checkRows[0].Description,
      Status || checkRows[0].Status,
      StartDate || checkRows[0].StartDate,
      EndDate || checkRows[0].EndDate,
      Severity || checkRows[0].Severity,
      Reaction || checkRows[0].Reaction,
      Dosage || checkRows[0].Dosage,
      Frequency || checkRows[0].Frequency,
      Notes || checkRows[0].Notes,
      historyId
    ]);

    res.json({
      success: true,
      message: 'Medical history entry updated successfully'
    });
  } catch (error) {
    console.error('Error updating medical history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update medical history entry' 
    });
  }
};

/**
 * Delete a medical history entry
 */
export const deleteMedicalHistory = async (req: Request, res: Response) => {
  try {
    const { historyId } = req.params;

    // Check if entry exists
    const [checkRows] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM medical_history WHERE HistoryID = ?',
      [historyId]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Medical history entry not found'
      });
    }

    await db.execute<ResultSetHeader>(
      'DELETE FROM medical_history WHERE HistoryID = ?',
      [historyId]
    );

    res.json({
      success: true,
      message: 'Medical history entry deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting medical history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete medical history entry' 
    });
  }
};

/**
 * Create multiple medical history entries at once (for batch operations)
 */
export const createMultipleMedicalHistory = async (req: Request, res: Response) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Entries array is required'
      });
    }

    const results: any[] = [];
    const errors: any[] = [];

    for (const entry of entries) {
      try {
        const {
          PatientID,
          ConsultationID,
          VisitID,
          RecordType,
          RecordName,
          Description,
          Status,
          StartDate,
          EndDate,
          Severity,
          Reaction,
          Dosage,
          Frequency,
          PrescribedBy,
          Notes,
          CreatedBy
        } = entry;

        // Validate required fields
        if (!PatientID || !RecordType || !RecordName) {
          errors.push({
            entry,
            error: 'PatientID, RecordType, and RecordName are required'
          });
          continue;
        }

        const query = `
          INSERT INTO medical_history (
            PatientID, ConsultationID, VisitID, RecordType, RecordName, 
            Description, Status, StartDate, EndDate, Severity, Reaction, 
            Dosage, Frequency, PrescribedBy, Notes, CreatedBy, CreatedAt, UpdatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `;

        const [result] = await db.execute<ResultSetHeader>(query, [
          PatientID,
          ConsultationID || null,
          VisitID || null,
          RecordType,
          RecordName,
          Description || null,
          Status || 'active',
          StartDate || null,
          EndDate || null,
          Severity || null,
          Reaction || null,
          Dosage || null,
          Frequency || null,
          PrescribedBy || null,
          Notes || null,
          CreatedBy
        ]);

        results.push({
          historyId: result.insertId,
          recordName: RecordName,
          success: true
        });
      } catch (error: any) {
        errors.push({
          entry,
          error: error.message
        });
      }
    }

    res.status(201).json({
      success: true,
      savedCount: results.length,
      errorCount: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error creating multiple medical history entries:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create medical history entries' 
    });
  }
};

// Helper function for auto-creating medical history from consultation
export interface MedicalHistoryEntryData {
  PatientID: number;
  ConsultationID: number;
  RecordType: string;
  RecordName: string;
  Description?: string;
  Status?: string;
  StartDate?: string;
  EndDate?: string;
  Severity?: string;
  Reaction?: string;
  Dosage?: string;
  Frequency?: string;
  PrescribedBy?: number;
  Notes?: string;
  CreatedBy: number;
}

/**
 * Auto-create medical history from consultation (for use in other controllers)
 */
export const autoCreateMedicalHistoryFromConsultation = async (
  patientId: number,
  consultationId: number,
  doctorId: number,
  formData: any
): Promise<number> => {
  try {
    const medicalHistoryEntries: MedicalHistoryEntryData[] = [];

    // Diagnosis
    if (formData.diagnosis?.trim()) {
      medicalHistoryEntries.push({
        PatientID: patientId,
        ConsultationID: consultationId,
        RecordType: 'condition',
        RecordName: formData.diagnosis,
        Description: `Primary diagnosis: ${formData.diagnosis}`,
        Status: 'active',
        StartDate: new Date().toISOString().split('T')[0],
        Severity: formData.severityAssessment || 'moderate',
        CreatedBy: doctorId
      });
    }

    // Chief Complaint
    if (formData.chiefComplaint?.trim()) {
      medicalHistoryEntries.push({
        PatientID: patientId,
        ConsultationID: consultationId,
        RecordType: 'other',
        RecordName: 'Chief Complaint',
        Description: formData.chiefComplaint,
        Status: 'resolved',
        StartDate: new Date().toISOString().split('T')[0],
        EndDate: new Date().toISOString().split('T')[0],
        CreatedBy: doctorId
      });
    }

    // Treatment Plan
    if (formData.treatmentPlan?.trim()) {
      medicalHistoryEntries.push({
        PatientID: patientId,
        ConsultationID: consultationId,
        RecordType: 'procedure',
        RecordName: 'Treatment Plan',
        Description: formData.treatmentPlan,
        Status: 'active',
        StartDate: new Date().toISOString().split('T')[0],
        CreatedBy: doctorId
      });
    }

    // Save all entries
    if (medicalHistoryEntries.length > 0) {
      for (const entry of medicalHistoryEntries) {
        await db.execute<ResultSetHeader>(
          `INSERT INTO medical_history 
           (PatientID, ConsultationID, RecordType, RecordName, Description, 
            Status, StartDate, EndDate, Severity, CreatedBy, CreatedAt, UpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            entry.PatientID,
            entry.ConsultationID,
            entry.RecordType,
            entry.RecordName,
            entry.Description || null,
            entry.Status || 'active',
            entry.StartDate || null,
            entry.EndDate || null,
            entry.Severity || null,
            entry.CreatedBy
          ]
        );
      }
    }

    return medicalHistoryEntries.length;
  } catch (error) {
    console.error('Error auto-creating medical history:', error);
    return 0;
  }
};