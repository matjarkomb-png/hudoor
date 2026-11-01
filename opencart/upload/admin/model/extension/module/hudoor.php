<?php
class ModelExtensionModuleHudoor extends Model {
	public function install() {
		$this->db->query("CREATE TABLE IF NOT EXISTS `" . DB_PREFIX . "hudoor_employee` (
			`employee_id` VARCHAR(40) NOT NULL,
			`name` VARCHAR(128) NOT NULL,
			`code` VARCHAR(64) NOT NULL DEFAULT '',
			`active` TINYINT(1) NOT NULL DEFAULT '1',
			`date_modified` DATETIME NOT NULL,
			PRIMARY KEY (`employee_id`)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci");

		$this->db->query("CREATE TABLE IF NOT EXISTS `" . DB_PREFIX . "hudoor_record` (
			`record_id` VARCHAR(40) NOT NULL,
			`employee_id` VARCHAR(40) NOT NULL,
			`employee_name` VARCHAR(128) NOT NULL,
			`employee_code` VARCHAR(64) NOT NULL DEFAULT '',
			`type` VARCHAR(3) NOT NULL,
			`time_local` DATETIME NOT NULL,
			`ts` BIGINT NOT NULL,
			`device` VARCHAR(64) NOT NULL DEFAULT '',
			`date_added` DATETIME NOT NULL,
			PRIMARY KEY (`record_id`),
			KEY `time_local` (`time_local`),
			KEY `employee_id` (`employee_id`)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci");
	}

	public function getEmployees() {
		$query = $this->db->query("SELECT * FROM `" . DB_PREFIX . "hudoor_employee` ORDER BY `active` DESC, `name` ASC");

		return $query->rows;
	}

	public function getRecords($data = array()) {
		$sql = "SELECT * FROM `" . DB_PREFIX . "hudoor_record` WHERE 1";

		if (!empty($data['filter_date_from'])) {
			$sql .= " AND `time_local` >= '" . $this->db->escape($data['filter_date_from']) . " 00:00:00'";
		}

		if (!empty($data['filter_date_to'])) {
			$sql .= " AND `time_local` <= '" . $this->db->escape($data['filter_date_to']) . " 23:59:59'";
		}

		if (!empty($data['filter_employee_id'])) {
			$sql .= " AND `employee_id` = '" . $this->db->escape($data['filter_employee_id']) . "'";
		}

		$sql .= " ORDER BY `time_local` ASC, `ts` ASC";

		$query = $this->db->query($sql);

		return $query->rows;
	}

	public function deleteRecord($record_id) {
		$this->db->query("DELETE FROM `" . DB_PREFIX . "hudoor_record` WHERE `record_id` = '" . $this->db->escape($record_id) . "'");
	}

	public function getLastSync() {
		$query = $this->db->query("SELECT MAX(`date_added`) AS last_sync, COUNT(*) AS total FROM `" . DB_PREFIX . "hudoor_record`");

		return $query->row;
	}
}
